import { inject } from '@tessera/di';
import { EventNode, LifecycleOptions, LifecycleService, type ServiceModule } from '@tessera/contracts';
import { DEFAULT_LIFECYCLE_OPTIONS, DefaultLifecycleService } from './lifecycle-service.ts';

/**
 * Registers the LifecycleService (and default LifecycleOptions unless the shell provided them) in the application DI scope.
 * The shell collects LifecycleContributions per phase and calls setPhase; this module only holds the state.
 */
export const lifecycleModule: ServiceModule = {
  id: '@tessera/lifecycle',
  dependsOn: ['@tessera/events'],
  install({ application }) {
    if (!application.has(LifecycleOptions)) application.provideValue(LifecycleOptions, DEFAULT_LIFECYCLE_OPTIONS, { owner: 'core' });
    application.provide(
      LifecycleService,
      () => {
        const node = inject(EventNode, { optional: true });
        return new DefaultLifecycleService({ options: inject(LifecycleOptions), ...(node ? { node } : {}) });
      },
      { owner: 'core' },
    );
  },
};
