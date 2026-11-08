import { Emitter, TesseraError, toDisposable, type Event, type IDisposable } from '@tessera/base';
import type { ViewDescriptor, ViewProvider, ViewRegistry } from '@tessera/contracts';
import { state, type Observable, type State } from '@tessera/reactive';

/** View types (descriptors from manifests or core code) and their providers (code). Application DI scope. */
export class DefaultViewRegistry implements ViewRegistry, IDisposable {
  readonly descriptors: Observable<ReadonlyMap<string, ViewDescriptor>>;
  readonly onDidRegisterProvider: Event<string>;
  /** Fires when a descriptor is registered or removed, so the workbench can reconcile default placements. */
  readonly onDidChangeDescriptors: Event<string>;

  readonly #descriptors: State<ReadonlyMap<string, ViewDescriptor>> = state<ReadonlyMap<string, ViewDescriptor>>(new Map(), { name: 'views.descriptors' });
  readonly #providers = new Map<string, ViewProvider>();
  readonly #registered = new Emitter<string>({ name: 'views.providerRegistered', deferInTransaction: false });
  readonly #changed = new Emitter<string>({ name: 'views.descriptorsChanged', deferInTransaction: false });
  readonly #unregistered = new Emitter<string>({ name: 'views.providerUnregistered', deferInTransaction: false });
  readonly onDidUnregisterProvider: Event<string>;

  constructor() {
    this.descriptors = this.#descriptors.asReadonly();
    this.onDidRegisterProvider = this.#registered.event;
    this.onDidChangeDescriptors = this.#changed.event;
    this.onDidUnregisterProvider = this.#unregistered.event;
  }

  register(descriptor: ViewDescriptor): IDisposable {
    // A view type belongs to the first registrant: a second descriptor (another plugin, or a plugin against the core) is refused, not merged in.
    const existing = this.#descriptors.peek().get(descriptor.id);
    if (existing !== undefined) {
      throw new TesseraError('plugin.duplicateContribution', `view type "${descriptor.id}" is already declared by "${existing.owner}"`, { details: { id: descriptor.id, owner: existing.owner } });
    }
    const frozen = Object.freeze({ ...descriptor });
    const next = new Map(this.#descriptors.peek());
    next.set(descriptor.id, frozen);
    this.#descriptors.set(next);
    this.#changed.fire(descriptor.id);
    return toDisposable(() => {
      if (this.#descriptors.peek().get(descriptor.id) !== frozen) return;
      const after = new Map(this.#descriptors.peek());
      after.delete(descriptor.id);
      this.#descriptors.set(after);
      this.#changed.fire(descriptor.id);
    });
  }

  descriptor(viewType: string): ViewDescriptor | undefined {
    return this.#descriptors.peek().get(viewType);
  }

  registerProvider(provider: ViewProvider): IDisposable {
    if (!this.#descriptors.peek().has(provider.viewType)) {
      throw new TesseraError('workbench.undeclaredView', `View type "${provider.viewType}" has no descriptor: declare it in contributes.views`, { details: { viewType: provider.viewType } });
    }
    if (this.#providers.has(provider.viewType)) {
      throw new TesseraError('workbench.duplicateProvider', `View type "${provider.viewType}" already has a provider`, { details: { viewType: provider.viewType } });
    }
    this.#providers.set(provider.viewType, provider);
    this.#registered.fire(provider.viewType);
    return toDisposable(() => {
      if (this.#providers.get(provider.viewType) !== provider) return;
      this.#providers.delete(provider.viewType);
      this.#unregistered.fire(provider.viewType);
    });
  }

  provider(viewType: string): ViewProvider | undefined {
    return this.#providers.get(viewType);
  }

  dispose(): void {
    this.#registered.dispose();
    this.#changed.dispose();
    this.#unregistered.dispose();
  }
}
