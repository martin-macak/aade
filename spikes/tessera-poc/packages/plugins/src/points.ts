import type { Schema } from '@tessera/base';
import { defineContributionPoint, type InterceptorContribution } from '@tessera/contracts';
import { z } from 'zod';

const interceptorSchema = z.object({
  id: z.string().min(1),
  kinds: z.array(z.enum(['command', 'event', 'service', 'activation', 'persistence', 'ipc'])).min(1),
  match: z.string().optional(),
  phase: z.enum(['outer', 'guard', 'transform', 'resilience', 'inner']).optional(),
  order: z.number().optional(),
  mode: z.enum(['guard', 'observer']).optional(),
  interactive: z.boolean().optional(),
  description: z.string().optional(),
}) as unknown as Schema<InterceptorContribution>;

/** The `interceptors` contribution point: declares an interceptor. Code registers the body at activation. */
export const interceptorsPoint: ReturnType<typeof defineContributionPoint<InterceptorContribution>> = defineContributionPoint<InterceptorContribution>(
  'interceptors',
  interceptorSchema,
  {
    description: 'Declares an interceptor (kinds, match, phase, order, mode). The plugin registers the code with ctx.interceptors.',
    // A declared guard that never runs is worse than none: the plugin must activate when what it guards happens. A literal command match
    // gives onCommand:<id> (the command service awaits that activation before it builds the invocation); any other match or kind gives '*'.
    activationEvents: (entry) => (entry.kinds.length === 1 && entry.kinds[0] === 'command' && entry.match !== undefined && !/[*?{}[\]!]/.test(entry.match) ? [`onCommand:${entry.match}`] : ['*']),
  },
);
