import type { Scope } from '@tessera/di';
import type { HostEnvironment } from './host.ts';

export interface InstallContext {
  readonly application: Scope;
  readonly window: Scope;
  readonly host: HostEnvironment;
}

/** One per implementation package: registers its services. No resolution, no side effects. */
export interface ServiceModule {
  /** The package name, for example '@tessera/commands'. */
  readonly id: string;
  readonly dependsOn?: readonly string[];
  install(ctx: InstallContext): void;
}
