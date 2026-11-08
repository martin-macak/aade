import { defineReactUi, defineReactView, type ReactUiModule, type ReactViewProps } from '@tessera/react/ui';
import type { AuditViewIntents, AuditViewState } from './audit-log.ts';

// The React view of audit.log: a table of the entries the audit interceptors recorded. State in, intents out.

function AuditLogView({ state, intents }: ReactViewProps<AuditViewState, AuditViewIntents>) {
  return (
    <div className="audit-view" data-testid="audit-view">
      <div className="audit-summary">
        <span data-testid="audit-commands">{state.commands} commands</span> · <span data-testid="audit-events">{state.events} events</span> ·{' '}
        <span data-testid="audit-errors">{state.errors} errors</span>{' '}
        <button type="button" onClick={() => intents.clear()}>
          Clear
        </button>
      </div>
      <table className="audit-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Kind</th>
            <th>Target</th>
            <th>Source</th>
            <th>Outcome</th>
            <th>ms</th>
          </tr>
        </thead>
        <tbody>
          {state.entries.map((e) => (
            <tr key={e.seq} data-outcome={e.outcome}>
              <td>{e.seq}</td>
              <td>{e.kind}</td>
              <td>{e.target}</td>
              <td>{e.source}</td>
              <td>{e.outcome}</td>
              <td>{e.durationMs.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ui: ReactUiModule = defineReactUi([defineReactView<AuditViewState, AuditViewIntents>('audit.log', AuditLogView)]);

export default ui;
