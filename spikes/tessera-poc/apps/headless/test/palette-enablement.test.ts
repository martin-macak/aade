import { describe, expect, it } from 'vitest';
import { MenuId, SelectionService } from '@tessera/contracts';
import { captureErrors } from '@tessera/testing';
import { TaskSelection } from '@tessera-poc/plugin-tasks/presenter';
import { createDemoApp } from '@tessera-poc/headless';
import { menuItems, presenterOf, statusOf, titles } from './kit.ts';

describe('C15: enablement through context keys', () => {
  it('C15: tasks.complete is hidden from the palette and greyed in view/title until the placement has a selection (tasks.hasSelection)', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'write the report' });
    const side = await app.workbench.showView('tasks.list');
    const placement = app.workbench.placement(side.id)!;
    expect(app.contextKeys.focused.peek()).toBe(placement.context); // the palette evaluates in the focused placement

    // nothing selected yet
    expect(placement.context.getValue('tasks.hasSelection')).toBe(false);
    expect(titles(menuItems(app, MenuId.CommandPalette, placement.context))).not.toContain('Complete Task'); // palette hides disabled commands
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('disabled');

    // select: the presenter sets the key in its placement context scope
    presenterOf(app, side).intents.select('t1');
    expect(placement.context.getValue('tasks.hasSelection')).toBe(true);
    expect(titles(menuItems(app, MenuId.CommandPalette, placement.context))).toContain('Complete Task');
    expect(statusOf(menuItems(app, MenuId.ViewTitle, placement.context), 'tasks.complete')).toBe('enabled');
    // the typed selection (not a flag) is available to the handler
    expect(app.get(SelectionService).of(TaskSelection).peek().map((t) => t.id)).toEqual(['t1']);
  });

  it('C15: running the enabled palette item completes the selected task; the key is per placement, so the other placement is unaffected', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const { openTwice } = await import('./kit.ts');
    const { side, dock } = await openTwice(app);
    presenterOf(app, side).intents.select('t1'); // shared selection: both placements have a selection
    expect(app.workbench.placement(dock.id)!.context.getValue('tasks.hasSelection')).toBe(true);
    const palette = app.get((await import('@tessera/contracts')).MenuService).createMenu(MenuId.CommandPalette, app.contextKeys.focused.peek());
    const item = palette.groups.peek().flatMap((g) => g.items).find((i) => i.command === 'tasks.complete')!;
    await palette.run(item);
    palette.dispose();
    expect(presenterOf(app, side).state().remaining).toBe(0);
    expect(presenterOf(app, dock).state().groups[0]?.rows[0]?.done).toBe(true); // the other placement shows it too
  });

  it('C15: enablement is enforced for every source: executing tasks.complete without a selection rejects with command.disabled', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const errors = captureErrors();
    await expect(app.commands.execute('tasks.complete', { id: 't1' }, { source: 'keybinding' })).rejects.toMatchObject({ code: 'command.disabled' });
    await expect(app.commands.execute('tasks.complete', { id: 't1' }, { source: 'api' })).rejects.toMatchObject({ code: 'command.disabled' });
    errors.drain();
    errors.dispose();
  });

  it('C15: closing the placement removes the selection and the key: the palette hides tasks.complete again', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'a' });
    const side = await app.workbench.showView('tasks.list');
    presenterOf(app, side).intents.select('t1');
    await app.workbench.hide(side.id); // a container placement is hidden by a delta
    await app.settle();
    expect(app.get(SelectionService).of(TaskSelection).peek()).toEqual([]);
    expect(titles(menuItems(app, MenuId.CommandPalette, app.contextKeys.focused.peek()))).not.toContain('Complete Task');
  });
});
