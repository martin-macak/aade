import type { DisposableStore, StateSchema, StoredValue } from '@tessera/base';
import type {
  ContextKeyScope,
  Placement,
  PlacementId,
  PlacementRef,
  PlacementStatus,
  Presenter,
  SelectionPublisher,
  ViewInstanceId,
  WindowId,
  WorkItem,
} from '@tessera/contracts';
import type { Scope } from '@tessera/di';
import { computed, state, type Observable, type State } from '@tessera/reactive';
import type { InstanceEntry } from './instances.ts';

/** The runtime object of one placement (contracts.md 15.4). The record in WorkbenchState says where it is; this owns what lives. */
export class PlacementImpl implements Placement {
  readonly id: PlacementId;
  readonly viewType: string;
  readonly instanceId: ViewInstanceId;
  readonly windowId: WindowId;
  workspaceId: string;

  readonly status: Observable<PlacementStatus>;
  readonly visible: Observable<boolean>;
  readonly focused: Observable<boolean>;
  readonly title: Observable<string>;
  readonly local: State<unknown>;
  readonly context: ContextKeyScope;

  readonly statusState: State<PlacementStatus>;
  readonly visibleState: State<boolean>;
  readonly focusedState: State<boolean>;
  readonly presenterState: State<Presenter | undefined>;

  scope: Scope | undefined;
  problem: string | undefined;
  /** Local state as stored (snapshot or the last live value). Migrated when the presenter is created. */
  storedLocal: StoredValue | undefined;
  localSchema: StateSchema<unknown> | undefined;
  readonly entry: InstanceEntry;
  /** true while this placement holds a reference on the live view instance. */
  acquired = false;
  /** In-process ShowViewOptions.workItem. Not persisted. */
  ownerOverride: WorkItem | undefined;
  store: DisposableStore | undefined;
  selection: (SelectionPublisher & { dispose(): void }) | undefined;

  constructor(init: {
    id: PlacementId;
    viewType: string;
    entry: InstanceEntry;
    workspaceId: string;
    windowId: WindowId;
    context: ContextKeyScope;
    status: PlacementStatus;
    storedLocal: StoredValue | undefined;
    titleOf: (viewType: string) => string;
  }) {
    this.id = init.id;
    this.viewType = init.viewType;
    this.entry = init.entry;
    this.instanceId = init.entry.id;
    this.workspaceId = init.workspaceId;
    this.windowId = init.windowId;
    this.context = init.context;
    this.storedLocal = init.storedLocal;
    this.problem = undefined;
    this.scope = undefined;
    this.localSchema = undefined;
    this.ownerOverride = undefined;
    this.store = undefined;
    this.selection = undefined;
    this.statusState = state<PlacementStatus>(init.status, { name: `placement.status:${init.id}` });
    this.visibleState = state(false, { name: `placement.visible:${init.id}` });
    this.focusedState = state(false, { name: `placement.focused:${init.id}` });
    this.presenterState = state<Presenter | undefined>(undefined, { name: `placement.presenter:${init.id}` });
    this.local = state<unknown>(undefined, { name: `placement.local:${init.id}` });
    this.status = this.statusState.asReadonly();
    this.visible = this.visibleState.asReadonly();
    this.focused = this.focusedState.asReadonly();
    this.title = computed(() => this.presenterState.get()?.title?.get() ?? init.titleOf(init.viewType), { name: `placement.title:${init.id}` });
  }

  get presenter(): Presenter | undefined {
    return this.presenterState.peek();
  }

  ref(): PlacementRef {
    return { id: this.id, viewType: this.viewType, instanceId: this.instanceId, workspaceId: this.workspaceId, windowId: this.windowId };
  }
}
