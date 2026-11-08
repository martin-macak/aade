import { memo, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  DockSurfaceHost,
  EDITOR_AREA_WORKSPACE,
  MenuId,
  PartId,
  PlacementStatus,
  QuickInputService,
  WorkbenchAdapterApi,
  WorkbenchService,
  type Placement,
  type PlacementId,
  type PartRecord,
  type WindowRecord,
  type WorkbenchState,
  type WorkspaceRecord,
} from '@tessera/contracts';
import { createViewContext } from '@tessera/dom';
import { computed } from '@tessera/reactive';
import { useConfig } from './config.ts';
import { useServices } from './contexts.ts';
import { ChromeBoundary } from './boundary.tsx';
import { MenuToolbar } from './menus.tsx';
import { Dialogs } from './dialogs.tsx';
import { Notifications } from './notifications.tsx';
import { QuickInput } from './palette.tsx';
import { StatusBar } from './status-bar.tsx';
import { useObservable } from './use-observable.ts';

// The WorkbenchRenderer view of the window (contracts.md 18.1): parts, workspaces, placements. It only reads the
// WorkbenchService state and reports user intents back (activate, close, part visibility). It owns no layout state.

/** Draws one placement: the view of its presenter, a placeholder, or a loading note. */
export function PlacementHost({ placement }: { readonly placement: Placement }): ReactElement {
  const config = useConfig();
  const services = useServices();
  const status = useObservable(placement.status);
  const host = useRef<HTMLDivElement>(null);
  const [ui, setUi] = useState<'loading' | 'ready' | 'missing'>(config.mounter.canMount(placement.viewType) ? 'ready' : 'loading');
  const presenter = placement.presenter;

  useEffect(() => {
    let cancelled = false;
    void config.mounter.ensureUi(placement.viewType).then((ok) => {
      if (!cancelled) setUi(ok ? 'ready' : 'missing');
    });
    return () => {
      cancelled = true;
    };
  }, [config.mounter, placement.viewType]);

  useEffect(() => {
    const element = host.current;
    if (!element || ui !== 'ready' || !presenter) return;
    const mounted = config.mounter.mount(element, { placement, presenter, context: createViewContext(services, placement) });
    return () => mounted.dispose();
  }, [config.mounter, placement, presenter, ui, services]);

  if (status === PlacementStatus.Placeholder || (!presenter && status !== PlacementStatus.Pending)) {
    return (
      <>
        {config.placeholder?.({ placement, problem: placement.problem }) ?? (
          <div className="tessera-placeholder" role="note" data-placeholder={placement.viewType}>
            <strong>{placement.viewType}</strong> is not available.
            <div>{placement.problem ?? 'The view type is unknown.'}</div>
          </div>
        )}
      </>
    );
  }
  if (!presenter) return <div className="tessera-loading">Loading {placement.viewType}</div>;
  if (ui === 'missing') {
    return (
      <div className="tessera-placeholder" role="note">
        The owner of <strong>{placement.viewType}</strong> has no React UI.
      </div>
    );
  }
  return <div ref={host} className="tessera-placement" tabIndex={-1} data-view-type={placement.viewType} />;
}

function usePlacement(id: PlacementId | undefined): Placement | undefined {
  const workbench = useServices().get(WorkbenchService);
  return id === undefined ? undefined : workbench.placement(id);
}

function TabLabel({ placement }: { readonly placement: Placement }): ReactElement {
  const title = useObservable(placement.title);
  return <>{title}</>;
}

/** A view pane: toolbar (the `view/title` menu in the placement's context) and the view. */
function PlacementPane({ placement }: { readonly placement: Placement }): ReactElement {
  return (
    <section className="tessera-pane" data-placement={placement.id}>
      <header className="tessera-pane-title">
        <span className="tessera-pane-label">
          <ChromeBoundary name="workspaceHeader">
            <TabLabel placement={placement} />
          </ChromeBoundary>
        </span>
        <ChromeBoundary name="menu">
          <MenuToolbar menuId={MenuId.ViewTitle} context={placement.context} label="View actions" />
        </ChromeBoundary>
      </header>
      <PlacementHost placement={placement} />
    </section>
  );
}

function Tabs({ ws }: { readonly ws: WorkspaceRecord }): ReactElement {
  const services = useServices();
  const workbench = services.get(WorkbenchService);
  const adapter = services.get(WorkbenchAdapterApi);
  const active = usePlacement(ws.active ?? ws.members[0]);
  return (
    <div className="tessera-tabs" data-workspace={ws.id}>
      <div className="tessera-tablist" role="tablist">
        {ws.members.map((id) => {
          const placement = workbench.placement(id);
          if (!placement) return null;
          return (
            <span key={id} className="tessera-tab" role="presentation">
              <button type="button" role="tab" aria-selected={id === (ws.active ?? ws.members[0])} onClick={() => void workbench.activate(id).catch(() => undefined)}>
                <ChromeBoundary name="workspaceHeader">
                  <TabLabel placement={placement} />
                </ChromeBoundary>
              </button>
              <button type="button" className="tessera-tab-close" aria-label="Close" onClick={() => adapter.requestClose(id)}>
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="tessera-tabpanel" role="tabpanel">
        {active ? <PlacementPane key={active.id} placement={active} /> : <div className="tessera-empty">No views open.</div>}
      </div>
    </div>
  );
}

function Accordion({ ws }: { readonly ws: WorkspaceRecord }): ReactElement {
  const services = useServices();
  const workbench = services.get(WorkbenchService);
  return (
    <div className="tessera-accordion" data-workspace={ws.id}>
      {ws.members.map((id) => {
        const placement = workbench.placement(id);
        if (!placement) return null;
        const collapsed = ws.collapsed.includes(id);
        return (
          <div key={id} className="tessera-accordion-section" data-collapsed={collapsed}>
            {collapsed ? (
              <header className="tessera-pane-title">
                <TabLabel placement={placement} />
              </header>
            ) : (
              <PlacementPane placement={placement} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Deck, zone and dialog workspaces: the active member, or every member for a zone. */
function Deck({ ws }: { readonly ws: WorkspaceRecord }): ReactElement {
  const workbench = useServices().get(WorkbenchService);
  const ids = ws.kind === 'zone' ? ws.members : ws.active ? [ws.active] : [];
  return (
    <div className={`tessera-${ws.kind}`} data-workspace={ws.id} role={ws.kind === 'dialog' ? 'dialog' : undefined}>
      {ids.map((id) => {
        const placement = workbench.placement(id);
        return placement ? <PlacementPane key={id} placement={placement} /> : null;
      })}
    </div>
  );
}

/**
 * The dock workspace. With a DockSurfaceHost (the dockview adapter) the dock draws itself into a host element and
 * mounts views through the ViewMounter. Without one (a fake surface, a jsdom test) the renderer falls back to tabs.
 */
function DockArea({ ws }: { readonly ws: WorkspaceRecord }): ReactElement {
  const services = useServices();
  const config = useConfig();
  const dock = services.get(DockSurfaceHost, { optional: true });
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = element.current;
    if (!dock || !host) return;
    const attached = dock.attach(ws.id, host, config.mounter);
    return () => attached.dispose();
  }, [dock, ws.id, config.mounter]);
  if (!dock) return <Tabs ws={ws} />;
  return <div ref={element} className="tessera-dock" data-workspace={ws.id} />;
}

function WorkspaceView({ ws }: { readonly ws: WorkspaceRecord }): ReactElement {
  switch (ws.kind) {
    case 'dock':
      return <DockArea ws={ws} />;
    case 'tabs':
      return <Tabs ws={ws} />;
    case 'accordion':
      return <Accordion ws={ws} />;
    default:
      return <Deck ws={ws} />;
  }
}

/** A side bar or the panel. Memoized: it re-renders when its part record or its workspace record changes, not on every state change. */
const Part = memo(function Part({ part, ws, className }: { readonly part: PartRecord | undefined; readonly ws: WorkspaceRecord | undefined; readonly className: string }): ReactElement | null {
  if (!part?.visible || !ws) return null;
  return (
    <aside className={className} data-part={part.id} aria-label={ws.title}>
      <WorkspaceView ws={ws} />
    </aside>
  );
});

const ActivityBar = memo(function ActivityBar({ win, workspaces }: { readonly win: WindowRecord; readonly workspaces: WorkbenchState['workspaces'] }): ReactElement {
  const workbench = useServices().get(WorkbenchService);
  const sideParts: readonly PartId[] = [PartId.PrimarySideBar, PartId.SecondarySideBar, PartId.Panel];
  return (
    <nav className="tessera-activitybar" aria-label="Activity bar">
      {sideParts.flatMap((partId) => {
        const part = win.parts[partId];
        if (!part) return [];
        return part.workspaces.map((wsId) => {
          const ws = workspaces[wsId];
          if (!ws) return null;
          return (
            <button
              key={wsId}
              type="button"
              aria-label={ws.title}
              title={ws.title}
              aria-pressed={part.visible}
              onClick={() => void workbench.setPartVisible(win.id, partId, !part.visible).catch(() => undefined)}
            >
              {ws.title.slice(0, 1)}
            </button>
          );
        });
      })}
    </nav>
  );
});

function TitleBar(): ReactElement {
  const services = useServices();
  const config = useConfig();
  return (
    <header className="tessera-titlebar">
      <span className="tessera-app-title">{config.title}</span>
      <button type="button" className="tessera-palette-button" onClick={() => void services.get(QuickInputService).showCommandPalette()}>
        Command Palette
      </button>
    </header>
  );
}

/** The whole window: title bar, activity bar, side bars, editor area (dock), panel, status bar, palette and notifications. */
export function Workbench(): ReactElement {
  const services = useServices();
  const config = useConfig();
  const workbench = services.get(WorkbenchService);
  // Narrow slices of the state: the chrome re-renders when its window record or the workspace records change. A focus change, a
  // placement change or a new view instance changes neither, so it renders no chrome and no other view (react-binding.md, cost model).
  const windowSlice = useMemo(() => computed(() => workbench.state.get().windows[config.windowId], { name: 'chrome.window' }), [workbench, config.windowId]);
  const workspaceSlice = useMemo(() => computed(() => workbench.state.get().workspaces, { name: 'chrome.workspaces' }), [workbench]);
  const win = useObservable(windowSlice);
  const workspaces = useObservable(workspaceSlice);
  const editor = workspaces[EDITOR_AREA_WORKSPACE];
  const activeOf = (partId: PartId): WorkspaceRecord | undefined => {
    const active = win?.parts[partId]?.active;
    return active === undefined ? undefined : workspaces[active];
  };
  return (
    <div className="tessera-workbench" data-window={config.windowId} data-tessera-chrome="">
      <TitleBar />
      <div className="tessera-main">
        {win ? <ActivityBar win={win} workspaces={workspaces} /> : null}
        {win ? <Part part={win.parts[PartId.PrimarySideBar]} ws={activeOf(PartId.PrimarySideBar)} className="tessera-sidebar tessera-sidebar-primary" /> : null}
        <div className="tessera-center">
          <main className="tessera-editor">{editor ? <WorkspaceView ws={editor} /> : null}</main>
          {win ? <Part part={win.parts[PartId.Panel]} ws={activeOf(PartId.Panel)} className="tessera-panel" /> : null}
        </div>
        {win ? <Part part={win.parts[PartId.SecondarySideBar]} ws={activeOf(PartId.SecondarySideBar)} className="tessera-sidebar tessera-sidebar-secondary" /> : null}
      </div>
      <ChromeBoundary name="statusBar">
        <StatusBar />
      </ChromeBoundary>
      <ChromeBoundary name="quickInput">
        <QuickInput />
      </ChromeBoundary>
      <Notifications />
      <Dialogs />
    </div>
  );
}
