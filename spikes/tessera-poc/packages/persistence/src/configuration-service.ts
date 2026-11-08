import { Emitter, TesseraError, type Event, type IDisposable, type Schema } from '@tessera/base';
import {
  ContextKeyService,
  ContributionRegistry,
  SETTINGS_STORAGE_KEY,
  StorageService,
  defineContributionPoint,
  type ConfigurationContribution,
  type ConfigurationService,
} from '@tessera/contracts';
import { injectScope, type Scope } from '@tessera/di';
import { computed, state, type Observable, type State } from '@tessera/reactive';
import { z } from 'zod';

type SettingValue = string | number | boolean;

const configurationSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'enum']),
  default: z.union([z.string(), z.number(), z.boolean()]),
  enum: z.array(z.string()).optional(),
  description: z.string().optional(),
  context: z.boolean().optional(),
}) as unknown as Schema<ConfigurationContribution>;

/** The `configuration` contribution point (contracts.md 14.2). Defined by the persistence module. */
export const configurationPoint: ReturnType<typeof defineContributionPoint<ConfigurationContribution>> = defineContributionPoint<ConfigurationContribution>(
  'configuration',
  configurationSchema,
  { description: 'Declares a setting with a default value.', identity: (entry) => entry.key },
);

function accepts(declaration: ConfigurationContribution, value: unknown): value is SettingValue {
  switch (declaration.type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'enum':
      return typeof value === 'string' && (declaration.enum ?? []).includes(value);
  }
}

/** Settings declared by `contributes.configuration`; user values live in the application scope under `tessera.settings`. */
export class DefaultConfigurationService implements ConfigurationService, IDisposable {
  readonly onDidChange: Event<{ readonly keys: readonly string[] }>;

  readonly #scope: Scope;
  readonly #changed = new Emitter<{ readonly keys: readonly string[] }>({ name: 'configuration.change' });
  readonly #tick: State<number> = state(0, { name: 'configuration.tick' });
  readonly #subscriptions: IDisposable[] = [];
  #mirrored = new Set<string>();

  constructor() {
    this.#scope = injectScope();
    this.onDidChange = this.#changed.event;
    const registry = this.#scope.get(ContributionRegistry);
    this.#subscriptions.push(
      registry.onDidChange((e) => {
        if (e.pointId === configurationPoint.id) this.#refresh([]);
      }),
      this.#scope.get(StorageService).onDidChange((e) => {
        if (e.scope === 'application' && e.external && e.keys.has(SETTINGS_STORAGE_KEY)) this.#refresh(['*']);
      }),
    );
  }

  /** The declarations map and the `context: true` subset, built from the registry list and reused until that list changes. */
  #cache: { readonly list: readonly unknown[]; readonly map: ReadonlyMap<string, ConfigurationContribution>; readonly contextual: readonly ConfigurationContribution[] } | undefined;
  /** Counter for the performance tests: how many times the declarations were rebuilt (at most one per change of the registry list). */
  declarationBuilds = 0;

  #declarations(): ReadonlyMap<string, ConfigurationContribution> {
    return this.#declared().map;
  }

  #declared(): { readonly map: ReadonlyMap<string, ConfigurationContribution>; readonly contextual: readonly ConfigurationContribution[] } {
    const list = this.#scope.get(ContributionRegistry).get(configurationPoint).peek();
    if (this.#cache?.list === list) return this.#cache;
    this.declarationBuilds++;
    const map = new Map<string, ConfigurationContribution>();
    for (const c of list) map.set(c.value.key, c.value);
    this.#cache = { list, map, contextual: [...map.values()].filter((d) => d.context === true) };
    return this.#cache;
  }

  #user(): Readonly<Record<string, unknown>> {
    const storage = this.#scope.get(StorageService);
    const raw = storage.get('application', SETTINGS_STORAGE_KEY);
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  }

  get<T extends SettingValue>(key: string): T | undefined {
    const declaration = this.#declarations().get(key);
    if (!declaration) return undefined;
    const user = this.#user()[key];
    // A stored value that fails the declared type or enum reads as the default.
    return (accepts(declaration, user) ? user : declaration.default) as T;
  }

  observe<T extends SettingValue>(key: string): Observable<T | undefined> {
    return computed(() => {
      this.#tick.get();
      this.#scope.get(ContributionRegistry).get(configurationPoint).get();
      return this.get<T>(key);
    }, { name: `configuration:${key}` });
  }

  update(key: string, value: SettingValue | undefined): void {
    const declaration = this.#declarations().get(key);
    if (!declaration) throw new TesseraError('config.invalid', `Unknown setting "${key}"`, { details: { key } });
    if (value !== undefined && !accepts(declaration, value)) {
      throw new TesseraError('config.invalid', `Value for "${key}" does not match the declared type "${declaration.type}"`, { details: { key, value } });
    }
    const next = { ...this.#user() };
    if (value === undefined) delete next[key];
    else next[key] = value;
    this.#scope.get(StorageService).set('application', SETTINGS_STORAGE_KEY, next);
    this.#refresh([key]);
  }

  #refresh(keys: readonly string[]): void {
    this.#tick.update((n) => n + 1);
    this.#mirrorContext();
    if (keys.length > 0) this.#changed.fire({ keys: keys.includes('*') ? [...this.#declarations().keys()] : keys });
  }

  /** Settings with `context: true` are mirrored as context keys `config.<key>` in the application scope. */
  #mirrorContext(): void {
    const contextKeys = this.#scope.get(ContextKeyService, { optional: true });
    if (!contextKeys) return;
    const now = new Set<string>();
    // only the declarations with `context: true`, from the cached subset: one lookup each, not a scan of every setting per setting
    for (const declaration of this.#declared().contextual) {
      now.add(declaration.key);
      contextKeys.root.set(`config.${declaration.key}`, this.get(declaration.key) as SettingValue);
    }
    for (const key of this.#mirrored) if (!now.has(key)) contextKeys.root.set(`config.${key}`, undefined);
    this.#mirrored = now;
  }

  /** Called once by the module after the point exists, to mirror the initial values. */
  start(): void {
    this.#mirrorContext();
  }

  dispose(): void {
    for (const s of this.#subscriptions.splice(0)) s.dispose();
    this.#changed.dispose();
  }
}
