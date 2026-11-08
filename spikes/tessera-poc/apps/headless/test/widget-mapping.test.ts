import { describe, expect, it } from 'vitest';
import * as contracts from '@tessera/contracts';
import { MenuId, StatusBarService } from '@tessera/contracts';
import { createDemoApp } from '@tessera-poc/headless';
import { menuItems, openTwice, presenterOf, statusOf } from './kit.ts';

// C31 (ADR-017): "widget" is a word, not a type. It maps onto three constructs that the sample plugins already use:
// a view in placements, a status bar item, and a toolbar item (view/title). This test shows the three together.
describe('C31: widgets map onto views, status bar items and toolbar items', () => {
  it('C31: Tessera has no Widget type', () => {
    const names = Object.keys(contracts).filter((name) => /widget/i.test(name));
    expect(names).toEqual([]);
  });

  it('C31: one view in two placements (the widget as a view), a live status bar item (the widget as a strip item), a toolbar item with enablement', async () => {
    const app = await createDemoApp({ only: ['sample.tasks', 'sample.taskStats'] });
    await app.toEventually();
    await app.commands.execute('tasks.add', { title: 'one' });
    await app.commands.execute('tasks.add', { title: 'two' });

    // meaning 1: a view; two placements share one view instance and keep their own presenters
    const { side, dock } = await openTwice(app);
    expect(side.instanceId).toBe(dock.instanceId);
    expect(side.id).not.toBe(dock.id);
    expect(app.workbench.placement(side.id)!.presenter).not.toBe(app.workbench.placement(dock.id)!.presenter);

    // meaning 3: a toolbar item (view/title); its enablement follows the context key of the placement
    const placement = app.workbench.placement(side.id)!;
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('disabled');
    presenterOf(app, side).intents.select('t1');
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('enabled');

    // meaning 2: a status bar item; its text follows the shared TaskStore through an observable
    const statusBar = app.get(StatusBarService);
    expect(statusBar.items(app.workItems.root.context).peek().left.map((i) => i.text)).toEqual(['2 open tasks']);
    await presenterOf(app, dock).intents.complete(); // an intent of the other placement; the item follows the shared store
    expect(statusBar.items(app.workItems.root.context).peek().left.map((i) => i.text)).toEqual(['1 open task']);
  });
});
