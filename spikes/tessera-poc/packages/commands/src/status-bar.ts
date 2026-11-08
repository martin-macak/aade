import { toDisposable, type IDisposable } from '@tessera/base';
import type { CommandService, ContextKeyScope, StatusBarItemRule, StatusBarItemView, StatusBarItems, StatusBarService } from '@tessera/contracts';
import { computed, isObservable, state, type Observable, type State } from '@tessera/reactive';
import { createRowGuard } from './row-guard.ts';

function read(value: string | Observable<string> | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.get();
}

const sameItem = (a: StatusBarItemView, b: StatusBarItemView | undefined): boolean =>
  b !== undefined && a.id === b.id && a.text === b.text && a.tooltip === b.tooltip && a.command === b.command && a.status === b.status;
const sameList = (a: readonly StatusBarItemView[], b: readonly StatusBarItemView[]): boolean => a.length === b.length && a.every((x, i) => sameItem(x, b[i]));

/**
 * The status bar presenter: rules in, view items out (with enablement and run). A rule that throws (a bad `when`, a throwing text
 * observable) is reported once and skipped, so one plugin cannot blank the bar. The window's CommandService comes from `commands`
 * (the POC has one window per application; a multi-window host makes this service window-scoped).
 */
export class DefaultStatusBarService implements StatusBarService {
  readonly #rules: State<readonly StatusBarItemRule[]> = state<readonly StatusBarItemRule[]>([], { name: 'statusBar.rules' });
  readonly #commands: (() => CommandService) | undefined;

  constructor(commands?: () => CommandService) {
    this.#commands = commands;
  }

  add(rule: StatusBarItemRule): IDisposable {
    const frozen = Object.freeze({ ...rule });
    this.#rules.update((list) => [...list, frozen]);
    return toDisposable(() => this.#rules.update((list) => list.filter((r) => r !== frozen)));
  }

  /** Visible items for a context-key scope. Left items run left to right, higher priority further left; right items the mirror image. */
  items(context: ContextKeyScope): Observable<StatusBarItems> {
    const guard = createRowGuard({ statusBar: true });
    return computed<StatusBarItems>(
      () => {
        const commands = this.#commands?.();
        const views: Array<{ readonly rule: StatusBarItemRule; readonly view: StatusBarItemView }> = [];
        for (const rule of this.#rules.get()) {
          guard(rule.id, rule.owner, () => {
            if (!context.evaluate(rule.when)) return;
            const text = read(rule.text) ?? '';
            const tooltip = read(rule.tooltip);
            let status: 'enabled' | 'disabled' = 'enabled';
            if (rule.command !== undefined && commands) {
              const presentation = commands.presentation(rule.command, context).get();
              // An informational item stays visible when its command is disabled or unknown: it is drawn disabled (a menu hides unavailable ones).
              status = presentation.status === 'enabled' ? 'enabled' : 'disabled';
            }
            const command = rule.command;
            views.push({
              rule,
              view: {
                id: rule.id,
                alignment: rule.alignment,
                text,
                tooltip,
                command,
                status,
                run: async (options) => {
                  if (command === undefined || !commands) return undefined;
                  return commands.execute(command, rule.args, { source: 'statusBar', context, ...(options?.signal ? { signal: options.signal } : {}) });
                },
              },
            });
          });
        }
        const left = views.filter((v) => v.view.alignment === 'left').toSorted((a, b) => (b.rule.priority ?? 0) - (a.rule.priority ?? 0));
        const right = views.filter((v) => v.view.alignment === 'right').toSorted((a, b) => (a.rule.priority ?? 0) - (b.rule.priority ?? 0));
        return { left: left.map((v) => v.view), right: right.map((v) => v.view) };
      },
      { name: 'statusBar.items', equals: (a, b) => sameList(a.left, b.left) && sameList(a.right, b.right) },
    );
  }
}

export { isObservable };
