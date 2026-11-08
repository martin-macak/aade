import { usePlacement, useSignal } from '../cap1-shared-view.tsx';
import { IAuditLog } from './audit.ts';

export default function AuditView() {
  const log = usePlacement().scope.get(IAuditLog);
  const entries = useSignal(log.changed, () => log.entries);
  return (
    <ol className="audit" data-testid="audit">
      {entries.map((e, i) => (
        <li key={i}>
          {e.kind} {e.id} {e.outcome ?? 'pending'} {e.durationMs === undefined ? '' : `${e.durationMs.toFixed(1)} ms`}
        </li>
      ))}
    </ol>
  );
}
