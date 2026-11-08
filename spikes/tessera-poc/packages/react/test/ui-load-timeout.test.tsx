import { act } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PlacementStatus } from '@tessera/contracts';
import { captureErrors, describePlugin } from '@tessera/testing';
import { counterManifest, renderCounterApp } from './app-kit.tsx';

// plugin-entry-load-unbounded: a ui entry whose import never settles ends after the bound, and the placement shows a note
// instead of an empty host that waits for ever.
describe('plugin-entry-load-unbounded: a hung ui import leaves the placement with a placeholder note', () => {
  it('after 10 s the placement host shows the "no React UI" note, plugin.uiLoadTimeout is reported, and the presenter stays usable', async () => {
    const description = describePlugin(counterManifest());
    const errors = captureErrors();
    const r = await renderCounterApp({ extraModules: { [`${description.location}#react`]: () => new Promise(() => undefined) } });
    let placement!: { id: string };
    await act(async () => {
      placement = await r.app.workbench.showView('counter.view');
    });
    await act(async () => {
      await r.app.settle();
    });
    const pane = (): HTMLElement => document.querySelector(`[data-placement="${placement.id}"]`) as HTMLElement;
    expect(pane().querySelector('.tessera-placeholder')).toBeNull(); // still waiting for the import
    expect(pane().querySelector('[data-view-type="counter.view"]')).not.toBeNull();
    await act(async () => {
      await r.app.advance(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    const note = pane().querySelector('.tessera-placeholder');
    expect(note?.textContent).toContain('has no React UI');
    expect(pane().querySelector('[data-view-type="counter.view"]')).toBeNull();
    expect(errors.drain().some((e) => ((e.error as { code?: string }).code ?? '') === 'plugin.uiLoadTimeout')).toBe(true);
    expect(r.app.workbench.placement(placement.id as never)?.status.peek()).not.toBe(PlacementStatus.Closed);
    errors.dispose();
    r.unmount();
  });
});
