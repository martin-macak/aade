import type { WebPlugin } from '@tessera/host-web';
import { manifest as auditManifest } from '@tessera-poc/plugin-audit/manifest';
import { manifest as faultyManifest } from '@tessera-poc/plugin-faulty/manifest';
import { manifest as taskStatsManifest } from '@tessera-poc/plugin-task-stats/manifest';
import { manifest as tasksManifest } from '@tessera-poc/plugin-tasks/manifest';

// The four sample plugins as the web host wants them. Manifests are tiny JSON and load now (they drive menus, the palette and
// activation events). The code loads on demand: each entry is a dynamic import and becomes its own chunk in `vite build`.
export const DEMO_PLUGINS: readonly WebPlugin[] = [
  { manifest: tasksManifest, main: () => import('@tessera-poc/plugin-tasks'), ui: { react: () => import('@tessera-poc/plugin-tasks/ui-react') } },
  { manifest: taskStatsManifest, main: () => import('@tessera-poc/plugin-task-stats') },
  { manifest: auditManifest, main: () => import('@tessera-poc/plugin-audit'), ui: { react: () => import('@tessera-poc/plugin-audit/ui-react') } },
  { manifest: faultyManifest, main: () => import('@tessera-poc/plugin-faulty') },
];
