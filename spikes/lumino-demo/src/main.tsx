// The demo page: boots one window with the sample plugins. Buttons call the same public services as the tests.
import '@lumino/default-theme/style/index.css';
import './demo.css';
import { createWindow } from './app.ts';
import { auditPlugin } from './plugins/audit.ts';
import { faultyPlugin } from './plugins/faulty.ts';
import { tasksPlugin } from './plugins/tasks.ts';

const STORAGE_KEY = 'lumino-demo.layout';
const host = document.getElementById('app')!;
const bar = document.createElement('div');
bar.id = 'toolbar';
document.body.prepend(bar);

const win = createWindow({ storage: window.localStorage, storageKey: STORAGE_KEY, onError: (error) => console.error('[interceptor]', error) });
for (const manifest of [auditPlugin, tasksPlugin, faultyPlugin]) win.plugins.register(manifest);
win.plugins.stateChanged.connect((_, { id, state, error }) => {
  if (state === 'failed') console.error(`Plugin ${id} failed to activate`, error);
});

const button = (label: string, run: () => unknown): void => {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => void Promise.resolve(run()).catch((error) => console.error(error));
  bar.append(b);
};
button('Tasks in side panel', () => win.open('tasks.list', 'side'));
button('Tasks in dock tab', () => win.open('tasks.list', 'editor'));
button('Audit log', () => win.open('audit.log', 'editor'));
button('Run faulty plugin', () => win.app.commands.execute('faulty.run'));
button('Deactivate tasks plugin', () => win.plugins.deactivate('sample.tasks'));
button('Seed v1 layout and reload', () => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(V1_LAYOUT));
  location.reload();
});
button('Reset storage and reload', () => {
  window.localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

// A layout written by an older build: view state schema v1 (`filter` instead of `query`, no `pinned`).
const V1_LAYOUT = {
  format: 1,
  dock: { type: 'tab-area', ids: ['tasks.list#dock'], currentIndex: 0 },
  side: { ids: ['tasks.list#side'], current: 0 },
  placements: [
    { id: 'tasks.list#side', type: 'tasks.list', workspace: 'side', stateVersion: 1, local: { filter: 'milk' } },
    { id: 'tasks.list#dock', type: 'tasks.list', workspace: 'editor', stateVersion: 1, local: { filter: 'report' } },
  ],
};

await win.start(host.id);
(window as unknown as { luminoDemo: unknown }).luminoDemo = win;
if (!(await win.layout.load())) {
  await win.open('tasks.list', 'side');
  await win.open('tasks.list', 'editor');
}
win.layout.autosave();
