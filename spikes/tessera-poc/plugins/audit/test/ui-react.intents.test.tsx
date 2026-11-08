import { createElement } from 'react';
import { fireEvent, render, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReactUiModule, ViewUiContext } from '@tessera/react/ui';
import ui from '../src/ui-react.tsx';
import type { AuditViewIntents, AuditViewState } from '../src/audit-log.ts';

// C26 (b) for audit.log: against a stub presenter, every outbound call is an intent; the ViewContext is a trap.
const trapContext = new Proxy({} as ViewUiContext, {
  get(_target, prop) {
    throw new Error(`the view used ViewUiContext.${String(prop)}`);
  },
});

const state: AuditViewState = Object.freeze({
  entries: Object.freeze([
    Object.freeze({ seq: 1, kind: 'command' as const, target: 'tasks.add', source: 'palette', outcome: 'ok' as const, durationMs: 1.234, detail: undefined }),
    Object.freeze({ seq: 2, kind: 'event' as const, target: 'tasks.changed', source: 'global', outcome: 'published' as const, durationMs: 0, detail: 'root' }),
    Object.freeze({ seq: 3, kind: 'command' as const, target: 'faulty.boom', source: 'api', outcome: 'error' as const, durationMs: 2, detail: 'boom' }),
  ]),
  commands: 2,
  events: 1,
  errors: 1,
});

describe('C26: audit.log React view against a stub presenter', () => {
  it('C26: the UI entry declares exactly one React view, audit.log', () => {
    expect((ui as ReactUiModule).views.map((v) => v.viewType)).toEqual(['audit.log']);
  });

  it('C26: it renders the counts and one row per entry from state, and marks the outcome', () => {
    const calls: string[] = [];
    const intents: AuditViewIntents = { clear: () => void calls.push('clear') };
    const { container } = render(createElement((ui as ReactUiModule).views[0]!.component, { state: state as never, intents: intents as never, context: trapContext }));
    expect(within(container).getByTestId('audit-commands').textContent).toBe('2 commands');
    expect(within(container).getByTestId('audit-events').textContent).toBe('1 events');
    expect(within(container).getByTestId('audit-errors').textContent).toBe('1 errors');
    const rows = [...container.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-outcome'))).toEqual(['ok', 'published', 'error']);
    expect(rows[0]?.textContent).toContain('tasks.add');
    expect(calls).toEqual([]);
  });

  it('C26: the only user action is Clear, and it calls the clear intent', () => {
    const calls: string[] = [];
    const intents: AuditViewIntents = { clear: () => void calls.push('clear') };
    const { container } = render(createElement((ui as ReactUiModule).views[0]!.component, { state: state as never, intents: intents as never, context: trapContext }));
    const buttons = within(container).getAllByRole('button');
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(calls).toEqual(['clear']);
  });
});
