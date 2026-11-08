import { useMemo, type ReactElement } from 'react';
import { StatusBarService, WorkItemService, type StatusBarItemView } from '@tessera/contracts';
import { useServices } from './contexts.ts';
import { useObservable } from './use-observable.ts';

/** The status bar. The StatusBarService owns presentation, enablement and run; this component only draws. */
export function StatusBar(): ReactElement {
  const services = useServices();
  const items = useMemo(() => services.get(StatusBarService).items(services.get(WorkItemService).root.context), [services]);
  const { left, right } = useObservable(items);
  const render = (list: readonly StatusBarItemView[]): ReactElement[] =>
    list.map((i) =>
      i.command ? (
        <button
          key={i.id}
          type="button"
          className="tessera-status-item"
          title={i.tooltip}
          data-status-item={i.id}
          disabled={i.status === 'disabled'}
          onClick={() => void i.run().catch(() => undefined)}
        >
          {i.text}
        </button>
      ) : (
        <span key={i.id} className="tessera-status-item" title={i.tooltip} data-status-item={i.id}>
          {i.text}
        </span>
      ),
    );
  return (
    <footer className="tessera-statusbar" role="status">
      <div className="tessera-status-left">{render(left)}</div>
      <div className="tessera-status-right">{render(right)}</div>
    </footer>
  );
}
