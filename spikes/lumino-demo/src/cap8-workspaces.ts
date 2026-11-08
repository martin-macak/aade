// Capability 8: workspaces, named containers that views are shown in.
//
// Native: the containers themselves (`DockPanel` for splittable tabbed areas, `TabPanel` for a plain tab stack, and
// `SplitPanel` / `BoxPanel` around them), and moving a widget between containers (`addWidget` re-parents).
// Lumino has no concept of a NAMED workspace or of "show this widget in workspace X". The registry below is that concept.
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { type DockPanel, type TabPanel, type Widget } from '@lumino/widgets';

export interface Workspace {
  readonly name: string;
  readonly container: Widget;
  add(widget: Widget): void;
  widgets(): Widget[];
  activate(widget: Widget): void;
}

export const dockWorkspace = (name: string, dock: DockPanel): Workspace => ({
  name,
  container: dock,
  add: (widget) => dock.addWidget(widget),
  widgets: () => [...dock.widgets()],
  activate: (widget) => dock.activateWidget(widget),
});

export const tabsWorkspace = (name: string, tabs: TabPanel): Workspace => ({
  name,
  container: tabs,
  add: (widget) => tabs.addWidget(widget),
  widgets: () => [...tabs.widgets],
  activate: (widget) => void (tabs.currentWidget = widget),
});

export class Workspaces {
  private readonly byName = new Map<string, Workspace>();

  register(workspace: Workspace): IDisposable {
    if (this.byName.has(workspace.name)) throw new Error(`Workspace "${workspace.name}" already exists`);
    this.byName.set(workspace.name, workspace);
    return new DisposableDelegate(() => void this.byName.delete(workspace.name));
  }

  get(name: string): Workspace {
    const workspace = this.byName.get(name);
    if (!workspace) throw new Error(`Unknown workspace "${name}"`);
    return workspace;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Show the widget in the named workspace. A widget that is shown elsewhere moves. */
  show(widget: Widget, name: string): void {
    const workspace = this.get(name);
    workspace.add(widget);
    workspace.activate(widget);
  }

  /** The name of the workspace that currently holds the widget, if any. */
  whereIs(widget: Widget): string | undefined {
    return [...this.byName.values()].find((workspace) => workspace.widgets().includes(widget))?.name;
  }
}
