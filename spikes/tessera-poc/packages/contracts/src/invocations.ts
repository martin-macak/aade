import type { CommandSource } from './commands.ts';
import type { PublishScope } from './events.ts';
import type { PlacementId } from './ids.ts';
import type { PluginHostKind } from './plugins.ts';
import type { StorageScope } from './storage.ts';

declare module '@tessera/interceptors' {
  interface InvocationKinds {
    command: CommandInvocation;
    event: EventInvocation;
    service: ServiceInvocation;
    activation: ActivationInvocation;
    persistence: PersistenceInvocation;
    ipc: IpcInvocation;
  }
}

export interface CommandInvocation {             // target: command id
  readonly commandId: string;
  readonly args: unknown;
  readonly source: CommandSource;
  readonly placementId: PlacementId | undefined;
  readonly forced: boolean;
  /** The plugin on whose behalf a plugin call runs (stamped by the plugin runtime). Absent for calls of the user and of the core. */
  readonly invoker?: string | undefined;
}
export interface EventInvocation {               // target: topic id. Observers only.
  readonly topicId: string;
  readonly payload: unknown;
  readonly scope: PublishScope;
  readonly nodeId: string;
  readonly origin: 'local' | 'remote';
}
export interface ServiceInvocation {             // target: 'tokenId.method'
  readonly tokenId: string;
  readonly method: string;
  readonly args: readonly unknown[];
}
export interface ActivationInvocation {          // target: plugin id
  readonly pluginId: string;
  readonly reason: string;                       // the activation event
  readonly host: PluginHostKind;
}
export interface PersistenceInvocation {         // target: 'load:application', 'write:project'
  readonly op: 'load' | 'write';
  readonly storageScope: StorageScope;
  readonly keys: readonly string[];
}
export interface IpcInvocation {                 // target: 'iface.method'
  readonly connection: string;
  readonly iface: string;
  readonly method: string;
  readonly direction: 'outgoing' | 'incoming';
  readonly args: readonly unknown[];
}
