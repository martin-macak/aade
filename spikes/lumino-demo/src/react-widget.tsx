// The Lumino to React adapter. Lumino ships no React binding (JupyterLab's `ReactWidget` lives in @jupyterlab/ui-components, not
// in @lumino/*), so this class is ours. It belongs to capability 1.
//
// Lifecycle notes found while building it:
//  - A React root is created once on the widget node, not on attach. Lumino detaches and re-attaches widgets when a tab moves, and
//    a root on a node that is merely moved keeps its state.
//  - `Widget.close()` does not dispose. The default `onCloseRequest` only un-parents the widget, so the tab close button would leave
//    the widget (and its React tree) alive. `onCloseRequest` is overridden to dispose.
//  - Disposal order matters: see dispose().
//  - `onActivateRequest` is where Lumino hands focus to a widget; the node needs a tabIndex to take it.
import { type Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import { type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

export class ReactWidget extends Widget {
  private readonly root: Root;

  constructor(element: ReactElement, options: { id: string; title: string; closable?: boolean }) {
    super();
    this.id = options.id;
    this.title.label = options.title;
    this.title.closable = options.closable ?? true;
    this.node.tabIndex = -1;
    this.root = createRoot(this.node);
    this.root.render(element);
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.node.focus();
  }

  protected override onCloseRequest(msg: Message): void {
    super.onCloseRequest(msg);
    this.dispose();
  }

  override dispose(): void {
    if (this.isDisposed) return;
    // Unmount BEFORE super.dispose(): that emits `disposed`, which closes the view's DI scope, and a React tree that renders
    // after its scope is gone throws. A view whose lazy component is still loading shows this order problem.
    this.root.unmount();
    super.dispose();
  }
}
