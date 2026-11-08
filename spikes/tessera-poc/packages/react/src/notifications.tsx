import { useState, type ReactElement } from 'react';
import { CommandService, NotificationService } from '@tessera/contracts';
import { useServices } from './contexts.ts';
import { useObservable } from './use-observable.ts';

/** Toasts for NotificationService.active. Dismissing hides a toast in this renderer only (the service keeps the model). */
export function Notifications(): ReactElement {
  const services = useServices();
  const active = useObservable(services.get(NotificationService).active);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const dismiss = (id: string): void => setDismissed((s) => new Set(s).add(id));
  const visible = active.filter((n) => !dismissed.has(n.id));
  return (
    <div className="tessera-notifications" aria-live="polite">
      {visible.map((n) => (
        <div key={n.id} className={`tessera-notification tessera-notification-${n.severity}`} role={n.severity === 'error' ? 'alert' : 'status'} data-notification={n.severity}>
          <div className="tessera-notification-body">
            <strong>{n.message}</strong>
            {n.detail ? <div className="tessera-notification-detail">{n.detail}</div> : null}
            {n.progress ? (
              <div className="tessera-notification-progress">
                {n.progress.message ? <div className="tessera-notification-progress-message">{n.progress.message}</div> : null}
                <progress aria-label={n.message} {...(n.progress.fraction !== undefined ? { value: n.progress.fraction, max: 1 } : {})} />
              </div>
            ) : null}
            {n.source ? <div className="tessera-notification-source">{n.source}</div> : null}
          </div>
          <div className="tessera-notification-actions">
            {(n.actions ?? []).map((a) => (
              <button
                key={a.title}
                type="button"
                onClick={() => {
                  void services.get(CommandService).execute(a.command, a.args, { source: 'menu' }).catch(() => undefined);
                  dismiss(n.id);
                }}
              >
                {a.title}
              </button>
            ))}
            {n.progress?.cancel ? (
              <button type="button" onClick={() => n.progress?.cancel?.()}>
                Cancel
              </button>
            ) : (
              <button type="button" aria-label="Dismiss notification" onClick={() => dismiss(n.id)}>
                Dismiss
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
