import type { CommandInvocation, EventInvocation, ServiceInvocation } from '@tessera/contracts';
import type { Interceptor, InterceptorPhase, InvocationContext } from '@tessera/interceptors';

// The invocation kinds (command, event, service...) are declared by @tessera/contracts through declaration merging.
// The tests use those real shapes; the helpers below fill the fields the pipeline does not care about.

export type CommandCtx = InvocationContext<'command'>;

export function commandData(commandId: string, args?: unknown): CommandInvocation {
  return { commandId, args, source: 'api', placementId: undefined, forced: false };
}

export function eventData(topicId: string, payload?: unknown): EventInvocation {
  return { topicId, payload, scope: 'global', nodeId: 'application', origin: 'local' };
}

export function serviceData(tokenId: string, method: string, args: readonly unknown[] = []): ServiceInvocation {
  return { tokenId, method, args };
}

/** An interceptor that logs "<id> in" and "<id> out" around next. */
export function logging(id: string, log: string[], extra?: Partial<Interceptor<'command', string>>): Interceptor<'command', string> {
  return {
    id,
    kinds: ['command'],
    async intercept(_ctx, next) {
      log.push(`${id} in`);
      try {
        return await next();
      } finally {
        log.push(`${id} out`);
      }
    },
    ...extra,
  };
}

export function phased(id: string, phase: InterceptorPhase, log: string[], order?: number): Interceptor<'command', string> {
  return logging(id, log, order === undefined ? { phase } : { phase, order });
}
