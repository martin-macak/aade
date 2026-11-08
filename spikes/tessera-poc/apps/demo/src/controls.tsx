import type { ReactElement } from 'react';
import { CommandService, EDITOR_AREA_WORKSPACE, QuickInputService, WorkbenchService } from '@tessera/contracts';
import type { ScopeReader } from '@tessera/di';
import { EventLog } from './event-log.tsx';

export interface ControlActions {
  /** Seeds an older layout and tasks into localStorage, then reloads the page (demo item 5). */
  readonly seedAndReload: () => void | Promise<void>;
  /** Clears the demo storage and reloads. */
  readonly resetAndReload: () => void | Promise<void>;
  readonly reload: () => void | Promise<void>;
}

/**
 * The demo's own buttons: one per step of the demo script (apps/demo/README.md). They call the same public services a user
 * action reaches: WorkbenchService, CommandService, QuickInputService. They hold no logic of the framework or the plugins.
 */
export function Controls({ services, actions }: { readonly services: ScopeReader; readonly actions: ControlActions }): ReactElement {
  const workbench = services.get(WorkbenchService);
  const commands = services.get(CommandService);
  const run = (promise: Promise<unknown>): void => void promise.catch(() => undefined); // the services report failures themselves
  return (
    <div data-tessera-chrome="">
      <div className="demo-controls" role="toolbar" aria-label="Demo script">
        <h1>Tessera POC</h1>
        <button type="button" data-demo="open-sidebar" onClick={() => run(workbench.showView('tasks.list'))}>
          1a. Tasks in side bar
        </button>
        <button type="button" data-demo="open-editor" onClick={() => run(workbench.showView('tasks.list', { workspace: EDITOR_AREA_WORKSPACE }))}>
          1b. Tasks in dock tab
        </button>
        <span className="demo-sep" />
        <button type="button" data-demo="palette" onClick={() => run(services.get(QuickInputService).showCommandPalette())}>
          2. Command palette
        </button>
        <button type="button" data-demo="add" onClick={() => run(commands.execute('tasks.add', undefined, { source: 'api' }))}>
          Add task (API)
        </button>
        <span className="demo-sep" />
        <button type="button" data-demo="open-audit" onClick={() => run(workbench.showView('audit.log', { workspace: EDITOR_AREA_WORKSPACE }))}>
          3. Audit log
        </button>
        <button type="button" data-demo="faulty" onClick={() => run(commands.execute('faulty.boom'))}>
          4. Run faulty plugin
        </button>
        <span className="demo-sep" />
        <button type="button" data-demo="seed" onClick={() => void actions.seedAndReload()}>
          5a. Seed v1 state and reload
        </button>
        <button type="button" data-demo="reload" onClick={() => void actions.reload()}>
          5b. Reload
        </button>
        <button type="button" data-demo="reset" onClick={() => void actions.resetAndReload()}>
          Reset storage
        </button>
      </div>
      <EventLog services={services} />
    </div>
  );
}
