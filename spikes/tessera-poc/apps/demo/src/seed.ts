import { LAYOUT_STORAGE_KEY } from '@tessera/contracts';
import { localStorageBackend } from '@tessera/host-web';
import layoutV1 from './layout-v1.json' with { type: 'json' };

/** The project id of the demo. localStorage keys: `tessera/project/demo/...`. */
export const DEMO_PROJECT = 'demo';

/**
 * Writes an older persisted state into localStorage: a layout snapshot whose `tasks.list` local state has schema version 1
 * (no localFilter, no pinned) and two tasks. The next start migrates it to version 2 when the presenter is created (demo item 5).
 * It replaces what is stored for the project.
 */
export async function seedOlderLayout(): Promise<void> {
  const backend = localStorageBackend({ projectId: DEMO_PROJECT });
  const existing = Object.keys(await backend.load('project'));
  await backend.write('project', {
    set: {
      [LAYOUT_STORAGE_KEY]: layoutV1,
      'plugin:sample.tasks:tasks': {
        v: 1,
        data: {
          tasks: [
            { id: 't1', title: 'Read the CAB book again', done: false, project: 'project-a' },
            { id: 't2', title: 'Write the framework', done: false, project: 'project-b' },
            { id: 't3', title: 'Ship the proof of concept', done: true, project: 'project-b' },
          ],
          nextId: 4,
        },
      },
    },
    delete: existing.filter((k) => k !== LAYOUT_STORAGE_KEY && k !== 'plugin:sample.tasks:tasks'),
  });
  backend.dispose();
}

/** Removes everything the demo stored. */
export function clearDemoStorage(): void {
  const backend = localStorageBackend({ projectId: DEMO_PROJECT });
  backend.clearAll();
  backend.dispose();
}
