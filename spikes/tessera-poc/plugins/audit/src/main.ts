import { WorkbenchService, definePlugin, inject, isKind } from '@tessera/plugin-api';
import type { PluginContext, PluginModule, ViewProvider } from '@tessera/plugin-api';
import { AuditLog, AuditLogToken, AuditPresenter, createAuditViewModel, type AuditViewIntents, type AuditViewModel, type AuditViewState } from './audit-log.ts';

export { AuditLog, AuditLogToken };
export type { AuditEntry } from './audit-log.ts';

const now = (): number => performance.now();

/** sample.audit (poc-plan section 3): an observer on commands, a sync observer on events, a guard on closing pinned placements. */
const plugin: PluginModule = definePlugin({
  activate(ctx: PluginContext): void {
    const log = new AuditLog();
    ctx.services.provide(AuditLogToken, () => log);
    const workbench = ctx.services.get(WorkbenchService);

    // Observer interceptor around every command. It cannot change the result: errors of next() are recorded, not rethrown.
    ctx.interceptors.register('audit.commands', async (ictx, next) => {
      if (!isKind(ictx, 'command')) return next();
      const started = now();
      const data = ictx.data;
      try {
        const result = await next();
        log.record({ kind: 'command', target: data.commandId, source: data.source, outcome: result === false ? 'vetoed' : 'ok', durationMs: now() - started, detail: undefined });
        return result;
      } catch (error) {
        log.record({ kind: 'command', target: data.commandId, source: data.source, outcome: 'error', durationMs: now() - started, detail: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    });

    // Sync observer on every event publication (events cannot be delayed or changed by interceptors).
    ctx.interceptors.registerObserver('audit.events', (ictx) => {
      if (!isKind(ictx, 'event')) return;
      const data = ictx.data;
      log.record({ kind: 'event', target: data.topicId, source: data.scope, outcome: 'published', durationMs: 0, detail: data.nodeId });
    });

    // Guard on workbench.closePlacement: a placement whose local state says `pinned` cannot be closed. No next() means veto.
    ctx.interceptors.register('audit.closeGuard', async (ictx, next) => {
      if (!isKind(ictx, 'command')) return next();
      const args = ictx.data.args as { id?: string; force?: boolean } | undefined; // the arguments of the command are the command's own (unknown here)
      const id = args?.id;
      const placement = id === undefined ? undefined : workbench.placement(id);
      const local = placement?.local.peek() as { pinned?: boolean } | undefined;
      if (local?.pinned === true && args?.force !== true) return false;
      return next();
    });

    const provider: ViewProvider<AuditViewModel, AuditViewState, AuditViewIntents> = {
      viewType: 'audit.log',
      createViewModel: () => createAuditViewModel(inject(AuditLogToken)),
      createPresenter: (pCtx) => new AuditPresenter(pCtx.viewModel),
    };
    ctx.views.registerProvider(provider);
  },
});

export default plugin;
