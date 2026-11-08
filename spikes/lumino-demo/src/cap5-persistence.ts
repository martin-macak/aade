// Capability 5: persistence of layout and view state, with restore and a schema migration from v1 to v2.
//
// Native: `DockPanel.saveLayout()` / `restoreLayout()`, `layoutModified`, and `TabPanel.currentChanged`. But `saveLayout()` returns
// `{ main: { type: 'tab-area', widgets: Widget[], currentIndex } | { type: 'split-area', children, sizes, orientation } }`:
// the tree holds LIVE Widget instances, not JSON, and `restoreLayout` needs instances too. So Lumino can neither write nor read a
// layout on its own. `TabPanel` has no save/restore at all.
// Ours: the widget <-> id mapping (widget.id is the placement id), the JSON document, recreating the widgets before
// `restoreLayout`, dropping what cannot be restored, the autosave trigger, and the migration. The v1 -> v2 migration belongs to the
// VIEW TYPE (`ViewType.stateVersion` + `migrateState`), because the framework cannot know a plugin's state shape.
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { type DockLayout, type DockPanel, type TabPanel, type Widget } from '@lumino/widgets';
import { type ViewHost } from './cap1-shared-view.tsx';
import { type Workspaces } from './cap8-workspaces.ts';

export const FORMAT_VERSION = 1;
export type AreaJson =
  | { type: 'tab-area'; ids: string[]; currentIndex: number }
  | { type: 'split-area'; orientation: 'horizontal' | 'vertical'; sizes: number[]; children: AreaJson[] };
export interface PlacementJson {
  id: string;
  type: string;
  workspace: string;
  stateVersion: number;
  local: unknown;
}
export interface LayoutDoc {
  format: number;
  dock: AreaJson | null;
  side: { ids: string[]; current: number };
  placements: PlacementJson[];
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class LayoutStore {
  private restoring = false;

  constructor(
    private readonly parts: { dock: DockPanel; side: TabPanel; sideName: string; views: ViewHost; workspaces: Workspaces; storage: StorageLike; key?: string },
  ) {}

  snapshot(): LayoutDoc {
    const { dock, side, views, workspaces } = this.parts;
    const area = (config: DockLayout.AreaConfig): AreaJson =>
      config.type === 'tab-area'
        ? { type: 'tab-area', ids: config.widgets.map((w) => w.id), currentIndex: config.currentIndex }
        : { type: 'split-area', orientation: config.orientation, sizes: config.sizes, children: config.children.map(area) };
    const main = dock.saveLayout().main;
    return {
      format: FORMAT_VERSION,
      dock: main ? area(main) : null,
      side: { ids: [...side.widgets].map((w) => w.id), current: side.currentIndex },
      placements: views.all().flatMap((p) => {
        const workspace = workspaces.whereIs(p.widget);
        return workspace ? [{ id: p.id, type: p.type.id, workspace, stateVersion: p.type.stateVersion, local: p.local.value }] : [];
      }),
    };
  }

  save(): void {
    if (this.parts.dock.isDisposed) return; // a save queued by autosave can run after the window was disposed
    this.parts.storage.setItem(this.parts.key ?? 'layout', JSON.stringify(this.snapshot()));
  }

  /** Read the stored document and restore it. Returns false when nothing is stored. */
  async load(): Promise<{ skipped: string[] } | false> {
    const raw = this.parts.storage.getItem(this.parts.key ?? 'layout');
    return raw ? this.restore(JSON.parse(raw) as LayoutDoc) : false;
  }

  /** Placements whose view type is unknown or whose plugin fails are skipped; the rest is restored. */
  async restore(doc: LayoutDoc): Promise<{ skipped: string[] }> {
    if (doc.format > FORMAT_VERSION) throw new Error(`Layout format ${doc.format} is newer than this build (${FORMAT_VERSION})`);
    const { dock, side, views, workspaces } = this.parts;
    this.restoring = true;
    try {
      views.closeWhere(() => true);
      const byId = new Map<string, Widget>();
      const skipped: string[] = [];
      for (const saved of doc.placements) {
        const type = views.getType(saved.type);
        try {
          if (!type) throw new Error(`Unknown view type "${saved.type}"`);
          const local = saved.stateVersion < type.stateVersion && type.migrateState ? type.migrateState(saved.stateVersion, saved.local) : saved.local;
          byId.set(saved.id, (await views.create(saved.type, { id: saved.id, local: local as object })).widget);
        } catch {
          skipped.push(saved.id);
        }
      }
      for (const id of doc.side.ids) if (byId.has(id)) workspaces.get(this.parts.sideName).add(byId.get(id)!);
      if (side.widgets.length > 0) side.currentIndex = Math.min(doc.side.current, side.widgets.length - 1);
      const realize = (area: AreaJson): DockLayout.AreaConfig | null => {
        if (area.type === 'tab-area') {
          const widgets = area.ids.flatMap((id) => byId.get(id) ?? []);
          return widgets.length ? { type: 'tab-area', widgets, currentIndex: Math.min(area.currentIndex, widgets.length - 1) } : null;
        }
        const kept = area.children.map((child, i) => [realize(child), area.sizes[i] ?? 1] as const).filter((pair): pair is readonly [DockLayout.AreaConfig, number] => pair[0] !== null);
        if (kept.length <= 1) return kept[0]?.[0] ?? null;
        return { type: 'split-area', orientation: area.orientation, children: kept.map(([c]) => c), sizes: kept.map(([, size]) => size) };
      };
      dock.restoreLayout({ main: doc.dock ? realize(doc.dock) : null });
      for (const widget of byId.values()) if (!widget.parent) widget.dispose(); // created, but the saved layout does not show it
      return { skipped };
    } finally {
      this.restoring = false;
    }
  }

  /** Save, coalesced to one write per microtask, whenever the layout, the tab selection, a placement or its local state changes. */
  autosave(): IDisposable {
    const { dock, side, views } = this.parts;
    let queued = false;
    const request = (): void => {
      if (queued || this.restoring) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        this.save();
      });
    };
    dock.layoutModified.connect(request);
    side.currentChanged.connect(request);
    views.changed.connect(request);
    return new DisposableDelegate(() => {
      dock.layoutModified.disconnect(request);
      side.currentChanged.disconnect(request);
      views.changed.disconnect(request);
    });
  }
}
