import { useState, type ReactElement } from 'react';
import { DialogService, type DialogRequest } from '@tessera/contracts';
import { useServices } from './contexts.ts';
import { useObservable } from './use-observable.ts';

/**
 * Draws the first request of DialogService.pending: a confirm (two buttons) or an input (one text field). The model owns the queue,
 * the validation and the answer; this component only shows them. Renderer chrome, not part of the plugin UI surface.
 */
export function Dialogs(): ReactElement | null {
  const dialogs = useServices().get(DialogService);
  const pending = useObservable(dialogs.pending);
  const request = pending[0];
  if (!request) return null;
  return <DialogView key={request.id} request={request} />;
}

function DialogView({ request }: { readonly request: DialogRequest }): ReactElement {
  const [value, setValue] = useState(request.initialValue);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = (): void => setError(request.accept(request.kind === 'input' ? value : undefined));
  return (
    <div className="tessera-dialog-backdrop">
      <div
        className={`tessera-dialog tessera-dialog-${request.severity}`}
        role={request.kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={request.title ?? request.message}
        data-dialog={request.kind}
        onKeyDown={(e) => {
          if (e.key === 'Escape') request.cancel();
        }}
      >
        {request.title ? <h2 className="tessera-dialog-title">{request.title}</h2> : null}
        <p className="tessera-dialog-message">{request.message}</p>
        {request.detail ? <p className="tessera-dialog-detail">{request.detail}</p> : null}
        {request.kind === 'input' ? (
          <input
            className="tessera-dialog-input"
            aria-label={request.message}
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
        ) : null}
        {error ? (
          <div className="tessera-dialog-error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="tessera-dialog-actions">
          <button type="button" onClick={() => request.cancel()}>
            {request.cancelLabel}
          </button>
          <button type="button" autoFocus={request.kind === 'confirm'} onClick={submit}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
