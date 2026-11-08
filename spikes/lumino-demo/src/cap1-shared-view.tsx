// Capability 1: one view type shown in two places at once, rendering one shared state, with separate per-placement state.
//
// Native: widgets and the containers that hold them. A Lumino `Widget` has one DOM node and one parent, so the SAME widget can
// never be in two places. The only shape is: one view TYPE, one widget per PLACEMENT.
// Ours: everything that makes the placements a family: the view type registry, the placement (widget + local state + DI scope),
// the lazily loaded React component, and the hooks that read a Lumino Signal (shared state) or the local state from React.
// The ReactWidget adapter is in react-widget.tsx.
import { UUID } from '@lumino/coreutils';
import { DisposableDelegate, type IDisposable } from '@lumino/disposable';
import { type ISignal, Signal } from '@lumino/signaling';
import { type ComponentType, createContext, lazy, Suspense, useContext, useSyncExternalStore } from 'react';
import { type Scope } from './cap7-di.ts';
import { ReactWidget } from './react-widget.tsx';

/** State that belongs to ONE placement. It is persisted with the layout (capability 5). */
export class LocalState<L extends object> {
  readonly changed = new Signal<this, void>(this);
  constructor(private current: L) {}
  get value(): L {
    return this.current;
  }
  patch(patch: Partial<L>): void {
    this.current = { ...this.current, ...patch };
    this.changed.emit();
  }
}

export interface ViewType<L extends object = object> {
  id: string;
  title: string;
  /** The plugin that owns the view; it is activated before the first placement is created. */
  plugin: string;
  defaultLocal: L;
  /** Schema version of the local state, and how to bring older saved state up to date (capability 5). */
  stateVersion: number;
  migrateState?: (from: number, state: unknown) => L;
  /** The React component is loaded on first use. */
  load: () => Promise<{ default: ComponentType }>;
}

export interface Placement<L extends object = object> {
  readonly id: string;
  readonly type: ViewType<L>;
  readonly local: LocalState<L>;
  /** DI scope of this placement (kind "view"); child of the window scope or of the owning WorkItem scope. */
  readonly scope: Scope;
  readonly widget: ReactWidget;
}

const PlacementContext = createContext<Placement | null>(null);

export function usePlacement<L extends object = object>(): Placement<L> {
  const placement = useContext(PlacementContext);
  if (!placement) throw new Error('usePlacement outside of a view');
  return placement as unknown as Placement<L>;
}

/** Read a Lumino Signal as React state. `snapshot` must return a stable reference until the signal fires. */
export function useSignal<T>(signal: ISignal<unknown, unknown>, snapshot: () => T): T {
  const subscribe = (notify: () => void): (() => void) => {
    const slot = (): void => notify();
    signal.connect(slot);
    return () => void signal.disconnect(slot);
  };
  return useSyncExternalStore(subscribe, snapshot);
}

export function useLocal<L extends object>(): readonly [L, (patch: Partial<L>) => void] {
  const { local } = usePlacement<L>();
  const value = useSignal(local.changed, () => local.value);
  return [value, (patch) => local.patch(patch)];
}

export class ViewHost {
  readonly changed = new Signal<this, void>(this);
  private readonly types = new Map<string, ViewType>();
  private readonly lazies = new Map<string, ComponentType>();
  private readonly byId = new Map<string, Placement>();

  constructor(
    private readonly windowScope: Scope,
    private readonly ensureActive: (plugin: string) => Promise<void>,
  ) {}

  register(type: ViewType<any>): IDisposable {
    if (this.types.has(type.id)) throw new Error(`View type "${type.id}" already registered`);
    this.types.set(type.id, type);
    return new DisposableDelegate(() => void this.types.delete(type.id));
  }

  getType(id: string): ViewType | undefined {
    return this.types.get(id);
  }

  all(): Placement[] {
    return [...this.byId.values()];
  }

  /** Create a placement. The widget is NOT shown yet; hand it to a workspace (capability 8). */
  async create(typeId: string, options: { id?: string; local?: object; scope?: Scope } = {}): Promise<Placement> {
    const type = this.types.get(typeId);
    if (!type) throw new Error(`Unknown view type "${typeId}"`);
    await this.ensureActive(type.plugin);
    const id = options.id ?? `${typeId}#${UUID.uuid4().slice(0, 8)}`;
    const scope = (options.scope ?? this.windowScope).createChild('view');
    const local = new LocalState({ ...type.defaultLocal, ...options.local });
    let View = this.lazies.get(typeId);
    if (!View) this.lazies.set(typeId, (View = lazy(type.load)));
    const placement = { id, type, local, scope } as { -readonly [K in keyof Placement]: Placement[K] };
    placement.widget = new ReactWidget(
      <PlacementContext.Provider value={placement as Placement}>
        <Suspense fallback={<p>Loading view...</p>}>
          <View />
        </Suspense>
      </PlacementContext.Provider>,
      { id, title: type.title },
    );
    this.byId.set(id, placement as Placement);
    local.changed.connect(() => this.changed.emit());
    placement.widget.disposed.connect(() => {
      this.byId.delete(id);
      Signal.clearData(local);
      scope.dispose();
      this.changed.emit();
    });
    this.changed.emit();
    return placement as Placement;
  }

  closeWhere(predicate: (placement: Placement) => boolean): void {
    for (const placement of this.all()) if (predicate(placement)) placement.widget.dispose();
  }
}
