import { describe, expect, it } from 'vitest';
import { MigrationStatus, type StateSchema } from '@tessera/base';
import { createTestScope } from '@tessera/testing';
import { DefaultStorageService, memoryStorageBackend } from '@tessera/persistence';

interface V2 {
  readonly title: string;
  readonly done: boolean;
}

// version 1 stored { title }, version 2 adds done, version 3 renames title to name -> here we keep 2 versions: v1 -> v2 -> v3
interface V3 {
  readonly name: string;
  readonly done: boolean;
}
const v3: StateSchema<V3> = {
  version: 3,
  schema: {
    safeParse: (i) => {
      const o = i as Partial<V3> | null;
      return o && typeof o.name === 'string' && typeof o.done === 'boolean' ? { success: true, data: o as V3 } : { success: false, error: { issues: [{ path: [], message: 'bad shape' }] } };
    },
  },
  initial: () => ({ name: '', done: false }),
  migrations: [
    { from: 1, migrate: (d) => ({ ...(d as object), done: false }) },
    { from: 2, migrate: (d) => ({ name: (d as V2).title, done: (d as V2).done }) },
  ],
};

async function setup(initial: Record<string, unknown>) {
  const t = createTestScope({ flat: true });
  const backend = memoryStorageBackend({ project: initial });
  const storage = new DefaultStorageService(backend);
  await storage.whenReady();
  t.application.track({ dispose: () => (storage.dispose(), backend.dispose()) });
  return { backend, storage };
}

describe('C22: versioned values', () => {
  it('C22: migrations run step by step from the stored version to the current one', async () => {
    const { storage } = await setup({ k: { v: 1, data: { title: 'Write tests' } } });
    const result = storage.getVersioned('project', 'k', v3);
    expect(result.status).toBe(MigrationStatus.Migrated);
    expect(result.fromVersion).toBe(1);
    expect(result.value).toEqual({ name: 'Write tests', done: false });
  });

  it('C22: a current value is returned as is and a missing value gives initial()', async () => {
    const { storage } = await setup({ k: { v: 3, data: { name: 'x', done: true } } });
    expect(storage.getVersioned('project', 'k', v3)).toMatchObject({ status: MigrationStatus.Current, value: { name: 'x', done: true } });
    expect(storage.getVersioned('project', 'none', v3)).toMatchObject({ status: MigrationStatus.Missing, value: { name: '', done: false } });
  });

  it('C22: a value newer than the app is reset and a backup <key>.bak.v<n> keeps the stored value', async () => {
    const newer = { v: 9, data: { future: true } };
    const { storage } = await setup({ k: newer });
    const result = storage.getVersioned('project', 'k', v3);
    expect(result.status).toBe(MigrationStatus.ResetNewer);
    expect(result.value).toEqual(v3.initial());
    await Promise.resolve(); // the backup is written outside the read (next microtask)
    expect(storage.get('project', 'k.bak.v9')).toEqual(newer);
    // the original key is left alone until the app writes a new value
    expect(storage.get('project', 'k')).toEqual(newer);
  });

  it('C22: an invalid value is reset with a backup, and getVersioned never throws', async () => {
    const { storage } = await setup({ k: { v: 3, data: { name: 5 } }, junk: 'not an envelope' });
    expect(storage.getVersioned('project', 'k', v3).status).toBe(MigrationStatus.ResetInvalid);
    await Promise.resolve();
    expect(storage.get('project', 'k.bak.v3')).toEqual({ v: 3, data: { name: 5 } });
    expect(storage.getVersioned('project', 'junk', v3).status).toBe(MigrationStatus.ResetInvalid);
    await Promise.resolve();
    expect(storage.get('project', 'junk.bak.vinvalid')).toBe('not an envelope');
  });

  it('C22: setVersioned stores the envelope { v, data } and a memento round-trips through it', async () => {
    const { storage, backend } = await setup({});
    const memento = storage.memento('project', 'workItem:root/tasks:filter', v3);
    expect(memento.get()).toEqual(v3.initial());
    memento.update((c) => ({ ...c, name: 'Inbox' }));
    expect(storage.get('project', 'workItem:root/tasks:filter')).toEqual({ v: 3, data: { name: 'Inbox', done: false } });
    await storage.flush();
    expect(backend.snapshot('project')['workItem:root/tasks:filter']).toEqual({ v: 3, data: { name: 'Inbox', done: false } });
    memento.reset();
    expect(memento.get()).toEqual(v3.initial());
    expect(storage.get('project', 'workItem:root/tasks:filter')).toBeUndefined();
  });
});

describe('C22: a read does not write (storage-read-has-write-side-effect)', () => {
  it('C22: N reads of a reset value give one backup write and no change event for the .bak key', async () => {
    const { storage } = await setup({ k: { v: 9, data: { future: true } } });
    const changes: string[] = [];
    storage.onDidChange((e) => changes.push(...e.keys));
    for (let i = 0; i < 5; i++) storage.getVersioned('project', 'k', v3);
    await Promise.resolve();
    expect(storage.get('project', 'k.bak.v9')).toEqual({ v: 9, data: { future: true } });
    expect(changes).toEqual([]);
    for (let i = 0; i < 5; i++) storage.getVersioned('project', 'k', v3);
    await Promise.resolve();
    expect(changes).toEqual([]);
    let writes = 0;
    storage.onDidChange(() => writes++);
    await storage.flush();
    expect(writes).toBe(0);
  });

  it('C22: the backup reaches the backend once', async () => {
    const { storage, backend } = await setup({ k: { v: 9, data: 1 } });
    for (let i = 0; i < 4; i++) storage.getVersioned('project', 'k', v3);
    await Promise.resolve();
    await storage.flush();
    expect(backend.writes).toHaveLength(1);
    expect(Object.keys(backend.writes[0]?.set ?? {})).toEqual(['k.bak.v9']);
  });
});
