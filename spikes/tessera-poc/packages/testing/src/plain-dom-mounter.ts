import { reportError, toDisposable, type IDisposable } from '@tessera/base';
import type { MountTarget, RendererId, ViewMounter } from '@tessera/contracts';

/** What the plain mounter needs from a host: a DOM element has it, and so has a bare object in a Node test. */
export interface TextHost {
  textContent: string | null;
}

export interface PlainView {
  /** The text for one viewState. */
  render(state: unknown): string;
  /** Named actions a test can press. Each one calls an intent of the presenter. */
  readonly actions?: Readonly<Record<string, (intents: unknown) => unknown>>;
}

/**
 * A test-only rendering adapter that draws viewState as plain text (poc-plan C27). It shows that a second renderer
 * needs nothing but a ViewMounter: it drives the same presenters, with one subscription per placement. It has no
 * framework and no workbench renderer, which is the point.
 */
export class PlainDomMounter implements ViewMounter<TextHost> {
  readonly rendererId: RendererId = 'plain';
  readonly #views = new Map<string, PlainView>();
  readonly #mounted = new Map<TextHost, MountTarget>();

  register(viewType: string, view: PlainView | ((state: unknown) => string)): IDisposable {
    this.#views.set(viewType, typeof view === 'function' ? { render: view } : view);
    return toDisposable(() => void this.#views.delete(viewType));
  }

  async ensureUi(viewType: string): Promise<boolean> {
    return this.#views.has(viewType);
  }

  canMount(viewType: string): boolean {
    return this.#views.has(viewType);
  }

  mount(host: TextHost, target: MountTarget): IDisposable {
    const view = this.#views.get(target.placement.viewType);
    const draw = (): void => {
      try {
        if (!view) throw new Error(`No plain view is registered for "${target.placement.viewType}".`);
        host.textContent = view.render(target.presenter.viewState.peek());
      } catch (error) {
        host.textContent = `[view failed: ${error instanceof Error ? error.message : String(error)}]`;
        target.context.reportError(error);
      }
    };
    draw();
    // one subscription per placement, like the React binding
    const subscription = target.presenter.viewState.subscribe(draw);
    this.#mounted.set(host, target);
    let done = false;
    return toDisposable(() => {
      if (done) return;
      done = true;
      subscription.dispose();
      this.#mounted.delete(host);
      host.textContent = '';
    });
  }

  /** Presses a named action of the view mounted in `host`. It calls the presenter's intent. */
  press(host: TextHost, action: string): unknown {
    const target = this.#mounted.get(host);
    if (!target) throw new Error('Nothing is mounted in this host.');
    const run = this.#views.get(target.placement.viewType)?.actions?.[action];
    if (!run) throw new Error(`The view "${target.placement.viewType}" has no action "${action}".`);
    try {
      return run(target.presenter.intents);
    } catch (error) {
      reportError(error, { source: 'view', target: target.placement.viewType });
      throw error;
    }
  }
}

export function plainDomMounter(): PlainDomMounter {
  return new PlainDomMounter();
}
