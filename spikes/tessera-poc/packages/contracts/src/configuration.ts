import type { Event } from '@tessera/base';
import { token, type Token } from '@tessera/di';
import type { Observable } from '@tessera/reactive';

// contracts.md section 16.2: configuration.

export interface ConfigurationService {
  get<T extends string | number | boolean>(key: string): T | undefined;
  observe<T extends string | number | boolean>(key: string): Observable<T | undefined>;
  /** undefined resets to the contributed default. Invalid values are rejected with 'config.invalid'. */
  update(key: string, value: string | number | boolean | undefined): void;
  readonly onDidChange: Event<{ readonly keys: readonly string[] }>;
}
export const ConfigurationService: Token<ConfigurationService> = token<ConfigurationService>('tessera.configuration');

export const SETTINGS_STORAGE_KEY = 'tessera.settings';
export const PLUGINS_DISABLED_STORAGE_KEY = 'tessera.plugins.disabled';
