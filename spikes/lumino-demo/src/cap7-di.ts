// Capability 7: dependency injection with hierarchical scopes (application > window > workitem > view), multi-bindings and
// deterministic disposal.
//
// Lumino gives only two relevant pieces: `Token<T>` (a typed key, reused here) and the flat plugin service registry
// (`IPlugin.provides` / `requires`). That registry has no scopes and no multi-bindings, and a second `provides` of the same token
// silently replaces the first (see @lumino/coreutils PluginRegistry.registerPlugin). `DisposableSet` disposes in INSERTION order,
// so it is not used for the ordering here. Everything below is our own mechanism.
import { type Token } from '@lumino/coreutils';
import { type IDisposable, DisposableDelegate } from '@lumino/disposable';

export type ScopeKind = 'application' | 'window' | 'workitem' | 'view' | (string & {});
export type Factory<T> = (scope: Scope) => T;
interface Binding {
  factory: Factory<unknown>;
  multi: boolean;
  scoped: boolean;
  declaredIn: Scope;
}
export interface BindOptions {
  /** Allow several bindings of the token; read them with getAll. A single binding of a token that is already bound throws. */
  multi?: boolean;
  /** One instance per requesting scope instead of one in the declaring scope. */
  scoped?: boolean;
}

const isDisposable = (value: unknown): value is IDisposable => typeof (value as IDisposable | null)?.dispose === 'function';

export class Scope implements IDisposable {
  readonly children: Scope[] = [];
  private readonly bindings = new Map<Token<unknown>, Binding[]>();
  private readonly instances = new Map<Binding, unknown>();
  private readonly owned: IDisposable[] = []; // creation order; disposed in reverse
  private readonly resolving = new Set<Binding>();
  private disposed = false;

  constructor(
    readonly kind: ScopeKind,
    readonly parent: Scope | null = null,
  ) {
    parent?.children.push(this);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  createChild(kind: ScopeKind): Scope {
    this.assertLive();
    return new Scope(kind, this);
  }

  bind<T>(token: Token<T>, factory: Factory<T>, options: BindOptions = {}): IDisposable {
    this.assertLive();
    const list = this.bindings.get(token) ?? [];
    if (list.length > 0 && !(options.multi && list.every((b) => b.multi))) throw new Error(`Token "${token.name}" is already bound in the ${this.kind} scope`);
    const binding: Binding = { factory, multi: options.multi ?? false, scoped: options.scoped ?? false, declaredIn: this };
    this.bindings.set(token, [...list, binding]);
    return new DisposableDelegate(() => {
      this.bindings.set(token, (this.bindings.get(token) ?? []).filter((b) => b !== binding));
    });
  }

  /** Register something that this scope disposes (in reverse registration order). */
  own<T extends IDisposable>(value: T): T {
    this.assertLive();
    this.owned.push(value);
    return value;
  }

  /** The nearest binding wins. Throws when there is none. */
  get<T>(token: Token<T>): T {
    const found = this.tryGet(token);
    if (found === undefined) throw new Error(`No binding for "${token.name}" in the ${this.kind} scope chain`);
    return found;
  }

  tryGet<T>(token: Token<T>): T | undefined {
    this.assertLive();
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const list = scope.bindings.get(token);
      const binding = list?.[list.length - 1];
      if (binding) {
        if (binding.multi) throw new Error(`Token "${token.name}" is multi-bound; use getAll`);
        return this.instantiate(binding) as T;
      }
    }
    return undefined;
  }

  /** All multi-bindings of the token, outermost scope first. */
  getAll<T>(token: Token<T>): T[] {
    this.assertLive();
    const chain: Scope[] = [];
    for (let scope: Scope | null = this; scope; scope = scope.parent) chain.unshift(scope);
    return chain.flatMap((scope) => (scope.bindings.get(token) ?? []).map((binding) => this.instantiate(binding) as T));
  }

  private instantiate(binding: Binding): unknown {
    const owner = binding.scoped ? this : binding.declaredIn;
    if (owner.instances.has(binding)) return owner.instances.get(binding);
    if (this.resolving.has(binding)) throw new Error('Circular dependency while resolving a binding');
    this.resolving.add(binding);
    try {
      const value = binding.factory(owner);
      owner.instances.set(binding, value);
      if (isDisposable(value)) owner.owned.push(value);
      return value;
    } finally {
      this.resolving.delete(binding);
    }
  }

  /** Children first (newest first), then own instances (newest first). Every disposable runs even if one throws. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const child of [...this.children].reverse()) attempt(() => child.dispose(), errors);
    for (const value of [...this.owned].reverse()) attempt(() => value.dispose(), errors);
    this.owned.length = 0;
    this.instances.clear();
    this.bindings.clear();
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    if (errors.length > 0) throw new AggregateError(errors, `Disposing the ${this.kind} scope failed`);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error(`The ${this.kind} scope is disposed`);
  }
}

function attempt(run: () => void, errors: unknown[]): void {
  try {
    run();
  } catch (error) {
    errors.push(error);
  }
}
