import { describe, expect, it } from 'vitest';
import { plainDomMounter, type TextHost } from '@tessera/testing';
import { resolveMountTarget } from '@tessera/dom';
import { createDemoApp } from '@tessera-poc/headless';
import type { TaskListIntents, TaskListState } from '@tessera-poc/plugin-tasks/presenter';
import { EDITOR } from './kit.ts';

// C27: a second renderer, with no React and no DOM: the test-only plain DOM mounter draws viewState as text and drives the SAME
// tasks.list presenters of sample.tasks, unchanged. Only a ViewMounter was needed (plus @tessera/dom for the mount target).

function draw(s: TaskListState): string {
  const lines = s.groups.flatMap((g) => [`[${g.project}]`, ...g.rows.map((r) => `${r.selected ? '>' : ' '} ${r.done ? 'x' : '-'} ${r.id} ${r.title}`)]);
  return [...lines, `open ${s.remaining}/${s.total}`, `scroll ${s.scrollTop}`, `filter ${s.localFilter}|${s.sharedFilter}`].join('\n');
}

describe('C27: the plain DOM mounter drives the real tasks.list presenters', () => {
  it('C27: two placements render one shared state as text, keep local state apart, and unmount cleanly', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    await app.commands.execute('tasks.add', { title: 'Write tests', project: 'project-a' });
    await app.commands.execute('tasks.add', { title: 'Ship it', project: 'project-b' });
    const side = await app.workbench.showView('tasks.list');
    const dock = await app.workbench.showView('tasks.list', { workspace: EDITOR });

    const mounter = plainDomMounter();
    const actions = {
      select: (i: unknown) => (i as TaskListIntents).select('t1'),
      scroll: (i: unknown) => (i as TaskListIntents).scrolled(77),
      filter: (i: unknown) => (i as TaskListIntents).setLocalFilter('ship'),
      add: (i: unknown) => (i as TaskListIntents).add('From plain text'),
    };
    mounter.register('tasks.list', { render: (s) => draw(s as TaskListState), actions });
    expect(await mounter.ensureUi('tasks.list')).toBe(true);

    const a: TextHost = { textContent: '' };
    const b: TextHost = { textContent: '' };
    const targetA = await resolveMountTarget(app.window, side.id);
    const targetB = await resolveMountTarget(app.window, dock.id);
    expect(targetA?.presenter).toBe(app.workbench.placement(side.id)?.presenter); // the framework's own presenters, not copies
    const mountA = mounter.mount(a, targetA!);
    const mountB = mounter.mount(b, targetB!);
    expect(a.textContent).toContain('- t1 Write tests');
    expect(a.textContent).toBe(b.textContent);

    mounter.press(a, 'select');
    expect(a.textContent).toContain('> - t1 Write tests');
    expect(b.textContent).toContain('> - t1 Write tests'); // shared state

    mounter.press(a, 'scroll');
    expect(a.textContent).toContain('scroll 77');
    expect(b.textContent).toContain('scroll 0'); // local state

    mounter.press(b, 'filter');
    expect(b.textContent).not.toContain('Write tests');
    expect(a.textContent).toContain('Write tests');

    await mounter.press(a, 'add');
    expect(a.textContent).toContain('open 3/3');
    expect(b.textContent).toContain('open 3/3');

    mountA.dispose();
    mountB.dispose();
    expect(a.textContent).toBe('');
    expect(b.textContent).toBe('');
  });

  it('C27: a placeholder has no mount target (the renderer shows its own placeholder)', async () => {
    const app = await createDemoApp({ only: ['sample.tasks'] });
    const placement = await app.workbench.showView('tasks.list');
    await app.plugins.deactivate('sample.tasks');
    await app.settle();
    expect(await resolveMountTarget(app.window, placement.id)).toBeUndefined();
  });
});
