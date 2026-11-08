// The sample audit plugin (domain code): a plugin-contributed interceptor for commands and events, and a view of the log.
//  - commands: the NATIVE observer (`commandExecuted`) wrapped by observeCommands, with timing
//  - events:   around advice on the bus hook of capability 6, with timing
// Both registrations are owned by the plugin, so deactivating it removes them.
import { Token } from '@lumino/coreutils';
import { Signal } from '@lumino/signaling';
import { observeCommands, type CallRecord } from '../cap3-interceptors.ts';
import { type PluginManifest } from '../cap4-plugins.ts';
import { ICommands, IInterceptors } from '../tokens.ts';

export class AuditLog {
  readonly changed = new Signal<this, void>(this);
  private current: readonly CallRecord[] = [];
  get entries(): readonly CallRecord[] {
    return this.current;
  }
  push(record: CallRecord): void {
    this.current = [...this.current.slice(-199), record];
    this.changed.emit();
  }
}
export const IAuditLog = new Token<AuditLog>('audit.log');

export const auditPlugin: PluginManifest<AuditLog> = {
  id: 'sample.audit',
  autoStart: true,
  provides: IAuditLog,
  views: [{ id: 'audit.log', title: 'Audit log', defaultLocal: {}, stateVersion: 1, load: () => import('./audit-view.tsx') }],
  activate(ctx) {
    const log = new AuditLog();
    ctx.own(observeCommands(ctx.scope.get(ICommands), (record) => log.push(record)));
    ctx.own(
      ctx.scope.get(IInterceptors).add((call, next) => {
        if (call.kind !== 'event') return next();
        const startedAt = performance.now();
        try {
          const result = next();
          log.push({ ...call, startedAt, durationMs: performance.now() - startedAt, outcome: 'ok' });
          return result;
        } catch (error) {
          log.push({ ...call, startedAt, durationMs: performance.now() - startedAt, outcome: 'error', error });
          throw error;
        }
      }),
    );
    return log;
  },
};
