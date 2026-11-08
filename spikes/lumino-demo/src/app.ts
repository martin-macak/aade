// The composition root: builds one window. It is shared by all capabilities (reported separately from the per-capability counts).
// It uses Lumino's `Application` as the plugin host, `BoxPanel` / `SplitPanel` / `TabPanel` / `DockPanel` for the shell,
// `MenuBar` / `CommandPalette` for the command surface, and binds everything else into our scopes.
//
// Gap: `Application` builds its own `CommandRegistry` in its constructor, and the palette and the menu bar need a registry, so the
// shell is built empty first, then the application, then the widgets that need `app.commands` are added to the shell.
import { Application } from '@lumino/application';
import { BoxPanel, CommandPalette, DockPanel, MenuBar, SplitPanel, TabPanel } from '@lumino/widgets';
import { ViewHost, type Placement } from './cap1-shared-view.tsx';
import { ContextKeys } from './cap2-context-keys.ts';
import { Contributions } from './contributions.ts';
import { Interceptors } from './cap3-interceptors.ts';
import { PluginHost } from './cap4-plugins.ts';
import { LayoutStore, type StorageLike } from './cap5-persistence.ts';
import { EventNode } from './cap6-event-bus.ts';
import { Scope } from './cap7-di.ts';
import { dockWorkspace, tabsWorkspace, Workspaces } from './cap8-workspaces.ts';
import { WorkItems } from './cap9-workitems.ts';
import { ICommands, IContextKeys, IContributions, IInterceptors, ILayout, IPalette, IPlugins, IRootEvents, IViews, IWorkItems, IWorkspaces } from './tokens.ts';

export interface DemoWindow {
  readonly app: Application;
  readonly appScope: Scope;
  readonly windowScope: Scope;
  readonly dock: DockPanel;
  readonly side: TabPanel;
  readonly menuBar: MenuBar;
  readonly palette: CommandPalette;
  readonly plugins: PluginHost;
  readonly views: ViewHost;
  readonly workspaces: Workspaces;
  readonly layout: LayoutStore;
  readonly events: EventNode;
  readonly keys: ContextKeys;
  readonly interceptors: Interceptors;
  readonly workItems: WorkItems;
  /** Create a placement and show it in the named workspace. */
  open(typeId: string, workspace: string, options?: Parameters<ViewHost['create']>[1]): Promise<Placement>;
  start(hostId: string): Promise<void>;
  dispose(): void;
}

export function createWindow(options: { storage: StorageLike; storageKey?: string; onError?: (error: unknown) => void }): DemoWindow {
  const appScope = new Scope('application');
  const windowScope = appScope.createChild('window');

  const shell = new BoxPanel({ direction: 'top-to-bottom', spacing: 0 });
  shell.id = 'shell';
  const app = new Application({ shell });

  const keys = new ContextKeys();
  const interceptors = new Interceptors(options.onError);
  const events = new EventNode('root', null, interceptors.eventHook);
  const menuBar = new MenuBar();
  const palette = new CommandPalette({ commands: app.commands });
  palette.id = 'palette';
  const side = new TabPanel({ tabPlacement: 'top' });
  side.id = 'side';
  const dock = new DockPanel();
  dock.id = 'editor';
  const main = new SplitPanel({ orientation: 'horizontal', spacing: 2 });
  main.addWidget(palette);
  main.addWidget(side);
  main.addWidget(dock);
  main.setRelativeSizes([2, 3, 6]);
  shell.addWidget(menuBar);
  shell.addWidget(main);
  BoxPanel.setStretch(main, 1);

  const workspaces = new Workspaces();
  workspaces.register(tabsWorkspace('side', side));
  workspaces.register(dockWorkspace('editor', dock));
  const contributions = new Contributions(app.commands, keys, menuBar, palette);
  const views = new ViewHost(windowScope, (plugin) => app.activatePlugin(plugin));
  const plugins = new PluginHost(app, appScope, windowScope, contributions, views);
  const workItems = new WorkItems(windowScope, events);
  const layout = new LayoutStore({ dock, side, sideName: 'side', views, workspaces, storage: options.storage, ...(options.storageKey ? { key: options.storageKey } : {}) });

  appScope.bind(IInterceptors, () => interceptors);
  appScope.bind(IRootEvents, () => events);
  appScope.bind(IPlugins, () => plugins);
  windowScope.bind(ICommands, () => app.commands);
  windowScope.bind(IPalette, () => palette);
  windowScope.bind(IContextKeys, () => keys);
  windowScope.bind(IContributions, () => contributions);
  windowScope.bind(IViews, () => views);
  windowScope.bind(IWorkspaces, () => workspaces);
  windowScope.bind(IWorkItems, () => workItems);
  windowScope.bind(ILayout, () => layout);

  return {
    app, appScope, windowScope, dock, side, menuBar, palette, plugins, views, workspaces, layout, events, keys, interceptors, workItems,
    async open(typeId, workspace, openOptions) {
      const placement = await views.create(typeId, openOptions);
      workspaces.show(placement.widget, workspace);
      return placement;
    },
    start: (hostId) => app.start({ hostID: hostId }),
    dispose() {
      // Gap: Application.start() adds listeners to document and window and offers no way to remove them. The Application object is
      // the listener, so removing them means repeating the capture flag it chose (capture unless `bubblingKeydown` is set).
      for (const type of ['keydown', 'keyup']) document.removeEventListener(type, app, true);
      document.removeEventListener('contextmenu', app);
      window.removeEventListener('resize', app);
      // Order: placements first (unmounts React, closes the view scopes), then the shell, then the remaining scopes. The ViewHost closes
      // the placements itself because DockPanel.dispose() leaves the widgets it holds undisposed (found by test, see C8).
      views.closeWhere(() => true);
      shell.dispose();
      appScope.dispose();
    },
  };
}
