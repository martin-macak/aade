import { bootDemo, type DemoHandle } from './boot.tsx';
import { clearDemoStorage, seedOlderLayout } from './seed.ts';

// The page entry. Reload actions first dispose the app (this flushes layout and storage into localStorage), then change the
// storage if they must, then reload the page. A plain browser reload works too: the host flushes on `pagehide`.
const root = document.getElementById('app');
const controls = document.getElementById('demo-controls');
if (!root) throw new Error('index.html has no #app element');

let demo: DemoHandle | undefined;
const stopThen = async (before: () => void | Promise<void>): Promise<void> => {
  await demo?.dispose();
  demo = undefined;
  await before();
  location.reload();
};

void bootDemo({
  root,
  ...(controls ? { controls } : {}),
  actions: {
    seedAndReload: () => stopThen(seedOlderLayout),
    resetAndReload: () => stopThen(clearDemoStorage),
    reload: () => stopThen(() => undefined),
  },
}).then((handle) => {
  demo = handle;
  (window as unknown as { tesseraDemo?: unknown }).tesseraDemo = handle.web; // for the browser console and the manual script
});
