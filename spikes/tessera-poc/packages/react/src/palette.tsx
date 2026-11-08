import { memo, useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';
import { QuickInputService, type QuickPickItem, type QuickPickSession } from '@tessera/contracts';
import { useServices } from './contexts.ts';
import { useObservable } from './use-observable.ts';

/** One row. Memoized on the item: moving the highlight renders the two rows that change, not the whole list. */
const Row = memo(function Row({ item, index, active, session }: { readonly item: QuickPickItem; readonly index: number; readonly active: boolean; readonly session: QuickPickSession }): ReactElement {
  return (
    <li
      id={`tessera-qi-${item.id}`}
      role="option"
      aria-selected={active}
      className={active ? 'tessera-qi-active' : undefined}
      onMouseEnter={() => session.setActive(index)}
      onMouseDown={(e) => {
        e.preventDefault();
        session.accept(item);
      }}
    >
      <span className="tessera-qi-label">{item.label}</span>
      {item.description ? <span className="tessera-qi-description">{item.description}</span> : null}
      {item.detail ? <kbd className="tessera-qi-detail">{item.detail}</kbd> : null}
    </li>
  );
});

/** Draws a QuickPickSession. The session owns filtering, ranking, the cap, the highlighted row and what the keys do; this only draws and forwards keys. */
function Picker({ session }: { readonly session: QuickPickSession }): ReactElement {
  const filter = useObservable(session.filter);
  const items = useObservable(session.visibleItems);
  const active = useObservable(session.activeIndex);
  const input = useRef<HTMLInputElement>(null);

  // focus the input on open and give the focus back to the previous element on close
  useEffect(() => {
    const field = input.current;
    const previous = field?.ownerDocument.activeElement;
    field?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      session.moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      session.moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      session.acceptActive();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      session.accept(undefined);
    }
  };

  return (
    <div className="tessera-quickinput-backdrop" onMouseDown={(e) => e.target === e.currentTarget && session.accept(undefined)}>
      <div className="tessera-quickinput" role="dialog" aria-label={session.placeholder ?? 'Quick input'}>
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls="tessera-quickinput-list"
          aria-activedescendant={items[active] ? `tessera-qi-${items[active].id}` : undefined}
          placeholder={session.placeholder}
          value={filter}
          onChange={(e) => session.filter.set(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul id="tessera-quickinput-list" role="listbox">
          {items.map((item, i) => (
            <Row key={item.id} item={item} index={i} active={i === active} session={session} />
          ))}
          {items.length === 0 ? <li className="tessera-qi-empty">No matching entries</li> : null}
        </ul>
      </div>
    </div>
  );
}

/** The quick pick and the command palette: renders QuickInputService.current. */
export function QuickInput(): ReactElement | null {
  const services = useServices();
  const session = useObservable(services.get(QuickInputService).current);
  return session ? <Picker session={session} /> : null;
}
