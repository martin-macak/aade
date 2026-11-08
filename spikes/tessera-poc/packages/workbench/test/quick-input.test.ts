import { describe, expect, it } from 'vitest';
import { QUICK_PICK_VISIBLE_CAP, QuickInputService, type QuickPickItem, type QuickPickSession } from '@tessera/contracts';
import { createTestApp } from '@tessera/testing';

// chrome-logic-in-react-adapter: the session owns ranking, the cap, the highlighted row and what the keys do.
const item = (id: string, label: string, description?: string): QuickPickItem => ({ id, label, ...(description ? { description } : {}) });

async function open(items: readonly QuickPickItem[], options?: Parameters<QuickInputService['pick']>[1]): Promise<{ session: QuickPickSession; result: Promise<QuickPickItem | undefined> }> {
  const app = await createTestApp({});
  const quick = app.get(QuickInputService);
  const result = quick.pick(items, options);
  const session = quick.current.peek() as QuickPickSession;
  return { session, result };
}

describe('C12: the quick pick session (chrome logic in the model)', () => {
  it('C12: ranks a label that starts with the text before a word start before a substring before a description match', async () => {
    const { session } = await open(
      [item('1', 'Open Recent'), item('2', 'Reopen Editor'), item('3', 'Go to Recent'), item('4', 'Recent Files'), item('5', 'Close', 'recent things'), item('6', 'Unrelated')],
      { matchOnDescription: true },
    );
    session.filter.set('rec');
    expect(session.visibleItems.peek().map((i) => i.id)).toEqual(['4', '1', '3', '5']);
    // '4' starts with it, '1' and '3' have a word that starts with it (original order), '5' only the description
    session.filter.set('open');
    expect(session.visibleItems.peek().map((i) => i.id)).toEqual(['1', '2']);
  });

  it('C12: shows at most 50 items, with or without a filter', async () => {
    const items = Array.from({ length: 500 }, (_, i) => item(String(i), `Command ${i}`));
    const { session } = await open(items);
    expect(session.visibleItems.peek()).toHaveLength(QUICK_PICK_VISIBLE_CAP);
    session.filter.set('command');
    expect(session.visibleItems.peek()).toHaveLength(QUICK_PICK_VISIBLE_CAP);
    session.filter.set('command 49');
    expect(session.visibleItems.peek().map((i) => i.label)).toContain('Command 49');
  });

  it('C12: moveActive stops at both ends, setActive jumps, and a new filter puts the highlight back on the first row', async () => {
    const { session } = await open([item('a', 'Alpha'), item('b', 'Beta'), item('c', 'Gamma')]);
    expect(session.activeIndex.peek()).toBe(0);
    session.moveActive(-1);
    expect(session.activeIndex.peek()).toBe(0);
    session.moveActive(1);
    session.moveActive(1);
    session.moveActive(1);
    expect(session.activeIndex.peek()).toBe(2);
    session.setActive(1);
    expect(session.activeIndex.peek()).toBe(1);
    session.filter.set('a');
    expect(session.activeIndex.peek()).toBe(0);
  });

  it('C12: the highlight cannot point past the list when the list shrinks', async () => {
    const { session } = await open([item('a', 'Alpha'), item('b', 'Beta'), item('c', 'Gamma')]);
    session.setActive(2);
    session.filter.set('zzz');
    expect(session.visibleItems.peek()).toEqual([]);
    expect(session.activeIndex.peek()).toBe(0);
    session.acceptActive(); // nothing to accept
    session.filter.set('');
    session.setActive(2);
    expect(session.activeIndex.peek()).toBe(2);
  });

  it('C12: acceptActive accepts the highlighted row', async () => {
    const { session, result } = await open([item('a', 'Alpha'), item('b', 'Beta')]);
    session.moveActive(1);
    session.acceptActive();
    expect(await result).toMatchObject({ id: 'b' });
  });
});
