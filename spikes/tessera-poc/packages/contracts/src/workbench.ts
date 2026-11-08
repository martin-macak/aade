import type { DisposableStore, Event, IDisposable, StateSchema } from '@tessera/base';
import { token, type Scope, type Token } from '@tessera/di';
import type { Observable, State } from '@tessera/reactive';
import type { ContextKeyScope, PluginContextKeyScope } from './context-keys.ts';
import type { Box, DockPosition, PartId, PlacementId, PlacementRef, PlacementStatus, ViewInstanceId, ViewInstanceRef, WindowId, WorkbenchState, WorkspaceKind } from './ids.ts';
import type { PluginWorkItem, WorkItem } from './workitems.ts';

// contracts.md section 15: workbench (views, presenters, placements, workspaces, selection, notifications, quick input).

export interface ViewDescriptor {
  readonly id: string;
  readonly title: string;
  readonly icon?: string;
  readonly owner: string;
  readonly when?: string;
  /** Default workspace. Default 'workbench.editorArea'. */
  readonly workspace?: string;
  /** Container workspaces: show a placement by default. Default true. */
  readonly visibleByDefault?: boolean;
  readonly multiplicity?: 'singleton' | 'keyed';
  /** May one instance have several placements at once? Default true. */
  readonly multiPlacement?: boolean;
  /** WorkItem path that owns the instances. Default 'root'. */
  readonly workItem?: string;
  readonly canMove?: boolean;
  readonly canClose?: boolean;
  /** After the last placement closes: 'grace' (default, 30 s), 'none', 'workItem'. */
  readonly retain?: 'grace' | 'none' | 'workItem';
  readonly order?: number;
  readonly renderMode?: 'onlyWhenVisible' | 'always';
}

export interface ViewProvider<VM = unknown, S = unknown, I = unknown, Sh = unknown, L = unknown> {
  readonly viewType: string;
  readonly sharedState?: StateSchema<Sh>;
  readonly localState?: StateSchema<L>;
  /** Once per view instance, inside the view DI scope's injection context. */
  createViewModel?(ctx: ViewModelContext<Sh>): VM;
  /** Once per placement, inside the placement DI scope's injection context. */
  createPresenter(ctx: PresenterContext<VM, L>): Presenter<S, I>;
}

export interface ViewRegistry {
  register(descriptor: ViewDescriptor): IDisposable;
  descriptor(viewType: string): ViewDescriptor | undefined;
  readonly descriptors: Observable<ReadonlyMap<string, ViewDescriptor>>;
  /** Throws 'workbench.undeclaredView' if no descriptor exists, 'workbench.duplicateProvider' if one is registered. */
  registerProvider(provider: ViewProvider): IDisposable;
  provider(viewType: string): ViewProvider | undefined;
  readonly onDidRegisterProvider: Event<string>;
}
export const ViewRegistry: Token<ViewRegistry> = token<ViewRegistry>('tessera.viewRegistry');

export interface ViewContract<S, I> {
  readonly viewState: Observable<S>;
  readonly intents: I;
}

export interface Presenter<S = unknown, I = unknown> extends ViewContract<S, I>, IDisposable {
  readonly title?: Observable<string>;
  readonly undoResource?: string;
  /** Close veto (dirty check). Not called with force. */
  canClose?(): boolean | Promise<boolean>;
}

export interface ViewModelContext<Sh> {
  readonly instance: ViewInstanceRef;
  readonly shared: State<Sh>;
  /** A plugin's provider gets a facade without `scope`. */
  readonly workItem: PluginWorkItem;
  readonly store: DisposableStore;
}

export interface PresenterContext<VM, L> {
  readonly placement: PlacementRef;
  readonly instance: ViewInstanceRef;
  readonly viewModel: VM;
  readonly local: State<L>;
  /** A plugin's provider gets a facade without `scope`. */
  readonly workItem: PluginWorkItem;
  readonly context: ContextKeyScope;
  readonly visible: Observable<boolean>;
  readonly focused: Observable<boolean>;
  readonly selection: SelectionPublisher;
  readonly store: DisposableStore;
}

export interface ViewInstance extends ViewInstanceRef {
  /** Core code only: the object a plugin gets from WorkbenchService.instance() hides it. */
  readonly scope: Scope;
  readonly viewModel: unknown;
  readonly shared: State<unknown>;
  readonly placements: Observable<ReadonlySet<PlacementId>>;
  readonly refCount: number;
}

export interface Placement extends PlacementRef {
  readonly status: Observable<PlacementStatus>;
  readonly visible: Observable<boolean>;
  readonly focused: Observable<boolean>;
  readonly title: Observable<string>;
  readonly local: State<unknown>;
  readonly context: ContextKeyScope;
  readonly presenter: Presenter | undefined;
  /** Core code only: the object a plugin gets from WorkbenchService.placement() hides it. */
  readonly scope: Scope | undefined;
  /** Set when status is 'placeholder'. */
  readonly problem: string | undefined;
}

/** A Placement as a plugin sees it: no DI `scope`, and `context` is the scope facade (no dispose, no createChild). */
export type PlacementView = Omit<Placement, 'scope' | 'context'> & { readonly context: PluginContextKeyScope };
/** A ViewInstance as a plugin sees it: no DI `scope`. */
export type ViewInstanceView = Omit<ViewInstance, 'scope'>;

/** What a plugin gets for the WorkbenchService token: placement() and instance() return views without the DI scope. */
export interface PluginWorkbenchService extends Omit<WorkbenchService, 'placement' | 'instance' | 'settle'> {
  placement(id: PlacementId | string): PlacementView | undefined;
  instance(id: ViewInstanceId): ViewInstanceView | undefined;
}

export interface ViewInstanceRegistry {
  acquire(viewType: string, key: string, owner: WorkItem): ViewInstance;
  release(id: ViewInstanceId): void;
  get(id: ViewInstanceId): ViewInstance | undefined;
  find(viewType: string, key: string): ViewInstance | undefined;
  /**
   * Resolves when the live part of the instance (view model, scope) is gone: a retire, a suspend of its view type or a reset still disposes it.
   * A caller that acquires the same instance again awaits this first, so two view models never overlap (`workbench.instanceRetiring`).
   * Bounded: it resolves after the dispose timeout at the latest.
   */
  whenRetired(viewType: string, key: string): Promise<void>;
}
export const ViewInstanceRegistry: Token<ViewInstanceRegistry> = token<ViewInstanceRegistry>('tessera.viewInstances');

export type PlacementTarget =
  | { readonly kind: 'workspace'; readonly workspace: string; readonly index?: number }
  | { readonly kind: 'dock'; readonly workspace: string; readonly position?: DockPosition }
  | { readonly kind: 'floating'; readonly workspace: string; readonly box?: Box }
  | { readonly kind: 'newWindow'; readonly bounds?: Box };

export interface ShowViewOptions {
  readonly key?: string;
  readonly workspace?: string;
  readonly target?: PlacementTarget;
  readonly reuse?: 'activate' | 'new';
  readonly focus?: boolean;
  /** The owner of a new instance. Only the path is used, so a plugin can pass its PluginWorkItem. */
  readonly workItem?: PluginWorkItem;
}

export interface WorkspaceInit {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly title: string;
  readonly icon?: string;
  readonly windowId?: WindowId;
  readonly partId?: PartId;
  readonly owner: string;
}

export interface WorkspaceHost {
  readonly id: string;
  readonly kind: WorkspaceKind;
  readonly placements: Observable<readonly PlacementId[]>;
  readonly active: Observable<PlacementId | undefined>;
  show(viewType: string, options?: Omit<ShowViewOptions, 'workspace' | 'target'>): Promise<PlacementRef>;
  activate(id: PlacementId): Promise<void>;
  hide(id: PlacementId): Promise<void>;
  close(id: PlacementId, options?: { readonly force?: boolean }): Promise<boolean>;
  readonly onDidActivate: Event<PlacementId>;
}

export interface WorkbenchService {
  readonly state: Observable<WorkbenchState>;
  readonly focused: Observable<PlacementRef | undefined>;
  showView(viewType: string, options?: ShowViewOptions): Promise<PlacementRef>;
  activate(id: PlacementId, options?: { readonly focus?: boolean }): Promise<void>;
  hide(id: PlacementId): Promise<void>;
  /** false when vetoed. */
  close(id: PlacementId, options?: { readonly force?: boolean }): Promise<boolean>;
  move(id: PlacementId, target: PlacementTarget): Promise<void>;
  setPartVisible(windowId: WindowId, part: PartId, visible: boolean): Promise<void>;
  createWorkspace(init: WorkspaceInit): IDisposable;
  workspace(id: string): WorkspaceHost | undefined;
  /** Resolves when background work (placeholder teardown, dock reports, presenter jobs) has settled. The workbench shutdown step awaits it. */
  settle(): Promise<void>;
  /** A placement id is an opaque string; a plugin that holds one as a plain string needs no cast. */
  placement(id: PlacementId | string): Placement | undefined;
  instance(id: ViewInstanceId): ViewInstance | undefined;
  resetLayout(): Promise<void>;
  /** Resolves when every placement visible after restore is attached or a placeholder. */
  whenRestored(): Promise<void>;
}
export const WorkbenchService: Token<WorkbenchService> = token<WorkbenchService>('tessera.workbench');

/** The `workbench.*` core commands that every WorkbenchService mutation executes. */
export const WorkbenchCommands = {
  showView: 'workbench.showView',
  activatePlacement: 'workbench.activatePlacement',
  hidePlacement: 'workbench.hidePlacement',
  closePlacement: 'workbench.closePlacement',
  movePlacement: 'workbench.movePlacement',
  setPartVisible: 'workbench.setPartVisible',
  resetLayout: 'workbench.resetLayout',
} as const;

/** The default dock workspace of the main window. */
export const EDITOR_AREA_WORKSPACE = 'workbench.editorArea';

// ----- selection -------------------------------------------------------------------------------

declare const selectionBrand: unique symbol;
export interface SelectionType<T> {
  readonly [selectionBrand]?: T;
  readonly id: string;
}
export function selectionType<T>(id: string): SelectionType<T> {
  return Object.freeze({ id }) as SelectionType<T>;
}

export interface SelectionPublisher {
  set<T>(type: SelectionType<T>, items: readonly T[]): void;
  clear(type?: SelectionType<unknown>): void;
}

export interface SelectionService {
  of<T>(type: SelectionType<T>): Observable<readonly T[]>;
  inPlacement<T>(id: PlacementId, type: SelectionType<T>): Observable<readonly T[]>;
}
export const SelectionService: Token<SelectionService> = token<SelectionService>('tessera.selection');

// ----- notifications and quick input -----------------------------------------------------------

export interface NotificationInit {
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly detail?: string;
  readonly actions?: ReadonlyArray<{ readonly title: string; readonly command: string; readonly args?: unknown }>;
  /** Plugin id, set by the facade. */
  readonly source?: string;
  /** Set while a task runs (NotificationService.withProgress). */
  readonly progress?: NotificationProgress;
}
/** A running task shown as a notification. Present while `withProgress` runs. */
export interface NotificationProgress {
  /** The latest message of the task ('Cloning 40%'). */
  readonly message?: string;
  /** 0 to 1 when the task knows how far it is. Absent: indeterminate. */
  readonly fraction?: number;
  /** true when the user can cancel (the task's signal aborts). */
  readonly cancellable: boolean;
  /** Aborts the task's signal. Present when `cancellable`. */
  cancel?(): void;
}

export interface ProgressOptions {
  readonly title: string;
  readonly cancellable?: boolean;
}
export interface ProgressReporter {
  /** `fraction` is absolute (0 to 1). A call replaces the earlier message. */
  report(update: { readonly message?: string; readonly fraction?: number }): void;
  /** Aborts when the user cancels (when `cancellable`) or when the task's owner ends (a plugin that deactivates). */
  readonly signal: AbortSignal;
}

export interface NotificationService {
  notify(notification: NotificationInit): IDisposable;
  readonly active: Observable<readonly (NotificationInit & { readonly id: string })[]>;
  /**
   * Shows a progress notification while `task` runs, and removes it when the task ends (result or error). The result of `task` is the
   * result of the call. In-process model in version 1; the shape for a remote host is deferred (RISK-DIALOG-REMOTE).
   */
  withProgress<T>(options: ProgressOptions, task: (progress: ProgressReporter) => Promise<T>): Promise<T>;
}
export const NotificationService: Token<NotificationService> = token<NotificationService>('tessera.notifications');

export interface ConfirmOptions {
  readonly title?: string;
  readonly message: string;
  readonly detail?: string;
  /** Default 'OK'. */
  readonly confirmLabel?: string;
  /** Default 'Cancel'. */
  readonly cancelLabel?: string;
  readonly severity?: 'info' | 'warning' | 'error';
  /** Aborting resolves the dialog as declined (false) and removes it. */
  readonly signal?: AbortSignal;
}
export interface InputOptions {
  readonly title?: string;
  readonly prompt: string;
  readonly placeholder?: string;
  readonly value?: string;
  /** Returns an error text to refuse the value, or undefined to accept it. The dialog stays open on an error. */
  readonly validate?: (value: string) => string | undefined;
  /** Aborting resolves the dialog as cancelled (undefined) and removes it. */
  readonly signal?: AbortSignal;
}
/** One dialog the user has to answer. The renderer draws `DialogService.pending[0]` and calls accept or cancel. */
export interface DialogRequest {
  readonly id: string;
  readonly kind: 'confirm' | 'input';
  readonly title: string | undefined;
  /** The message of a confirm, the prompt of an input. */
  readonly message: string;
  readonly detail: string | undefined;
  readonly severity: 'info' | 'warning' | 'error';
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly placeholder: string | undefined;
  readonly initialValue: string;
  /** Confirm: resolves true. Input: validates `value`, resolves it, and returns undefined; on a validation error returns its text and stays open. */
  accept(value?: string): string | undefined;
  /** Confirm: resolves false. Input: resolves undefined. */
  cancel(): void;
}
/** Modal questions to the user: the one prompt model of the platform (undo confirmation, interactive guards, plugin dialogs). */
export interface DialogService {
  /** false when the user declines or the signal aborts. Requests queue: one dialog at a time. */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** The entered text, or undefined when the user cancels or the signal aborts. */
  input(options: InputOptions): Promise<string | undefined>;
  /** The queue, oldest first. A renderer draws the first. */
  readonly pending: Observable<readonly DialogRequest[]>;
}
export const DialogService: Token<DialogService> = token<DialogService>('tessera.dialog');

export interface QuickPickItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
}
export interface QuickPickOptions {
  readonly placeholder?: string;
  readonly signal?: AbortSignal;
  readonly matchOnDescription?: boolean;
}
/** The most items a quick pick shows at once. A filter narrows the rest. */
export const QUICK_PICK_VISIBLE_CAP = 50;

/**
 * One picker (the quick pick or the command palette). The session owns the behavior; a renderer only draws it: the filter, the
 * ranked and capped list, the highlighted row and the keys' effect (react-binding.md, "chrome rules a second renderer takes from the models").
 */
export interface QuickPickSession {
  readonly items: readonly QuickPickItem[];
  readonly placeholder: string | undefined;
  readonly filter: State<string>;
  /** The items that match the filter, best first (label starts with the text, then a word starts with it, then the label contains it, then the description), at most QUICK_PICK_VISIBLE_CAP. */
  readonly visibleItems: Observable<readonly QuickPickItem[]>;
  /** The highlighted row of visibleItems. 0 after every change of the filter. */
  readonly activeIndex: Observable<number>;
  setActive(index: number): void;
  /** ArrowDown is +1, ArrowUp is -1. Stops at the first and the last row. */
  moveActive(delta: number): void;
  /** Enter: accepts the highlighted row (nothing when the list is empty). */
  acceptActive(): void;
  accept(item: QuickPickItem | undefined): void;
}
export interface QuickInputService {
  pick<T extends QuickPickItem>(items: readonly T[], options?: QuickPickOptions): Promise<T | undefined>;
  readonly current: Observable<QuickPickSession | undefined>;
  showCommandPalette(): Promise<void>;
}
export const QuickInputService: Token<QuickInputService> = token<QuickInputService>('tessera.quickInput');
