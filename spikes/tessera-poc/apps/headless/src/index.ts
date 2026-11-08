import type { PluginDescription } from '@tessera/contracts';
import { createTestApp, describePlugin, type TestApp, type TestAppOptions } from '@tessera/testing';
import auditPlugin from '@tessera-poc/plugin-audit';
import { manifest as auditManifest } from '@tessera-poc/plugin-audit/manifest';
import faultyPlugin from '@tessera-poc/plugin-faulty';
import { manifest as faultyManifest } from '@tessera-poc/plugin-faulty/manifest';
import taskStatsPlugin from '@tessera-poc/plugin-task-stats';
import { manifest as taskStatsManifest } from '@tessera-poc/plugin-task-stats/manifest';
import tasksPlugin from '@tessera-poc/plugin-tasks';
import { manifest as tasksManifest } from '@tessera-poc/plugin-tasks/manifest';

// The headless integration app (poc-plan section 2): createTestApp over the four sample plugins, in Node, no DOM.
// Stage C reuses SAMPLE_PLUGINS for the Vite demo app.

export type SamplePluginId = 'sample.tasks' | 'sample.taskStats' | 'sample.audit' | 'sample.faulty';

export const SAMPLE_PLUGIN_IDS: readonly SamplePluginId[] = ['sample.tasks', 'sample.taskStats', 'sample.audit', 'sample.faulty'];

interface Sample {
  readonly description: PluginDescription;
  readonly module: unknown;
}

const samples: Readonly<Record<SamplePluginId, Sample>> = {
  'sample.tasks': { description: describePlugin(tasksManifest, 'builtin'), module: tasksPlugin },
  'sample.taskStats': { description: describePlugin(taskStatsManifest, 'builtin'), module: taskStatsPlugin },
  'sample.audit': { description: describePlugin(auditManifest, 'builtin'), module: auditPlugin },
  'sample.faulty': { description: describePlugin(faultyManifest, 'builtin'), module: faultyPlugin },
};

export const SAMPLE_PLUGINS: readonly PluginDescription[] = SAMPLE_PLUGIN_IDS.map((id) => samples[id].description);

export interface DemoAppOptions extends Omit<TestAppOptions, 'plugins' | 'modules'> {
  /** Which sample plugins the catalog lists. Default: all four. */
  readonly only?: readonly SamplePluginId[];
  /** Called with the plugin id every time the loader imports a plugin entry (tests count activations with it). */
  readonly onLoad?: (pluginId: string) => void;
  /** Descriptions to add to the catalog besides the samples (for example a copy of a manifest with changed capabilities). */
  readonly extraPlugins?: readonly PluginDescription[];
  readonly extraModules?: Readonly<Record<string, unknown>>;
  /** Replaces a sample's description (same plugin, other manifest). */
  readonly override?: Partial<Record<SamplePluginId, PluginDescription>>;
}

export async function createDemoApp(options: DemoAppOptions = {}): Promise<TestApp> {
  const ids = options.only ?? SAMPLE_PLUGIN_IDS;
  const descriptions = ids.map((id) => options.override?.[id] ?? samples[id].description);
  const modules: Record<string, unknown> = { ...options.extraModules };
  for (const id of ids) {
    const description = options.override?.[id] ?? samples[id].description;
    modules[description.location] = () => {
      options.onLoad?.(id);
      return samples[id].module;
    };
  }
  const { only, onLoad, extraPlugins, extraModules, override, ...rest } = options;
  void only;
  void onLoad;
  void extraModules;
  void override;
  return createTestApp({ ...rest, plugins: [...descriptions, ...(extraPlugins ?? [])], modules });
}

export { auditManifest, faultyManifest, taskStatsManifest, tasksManifest };
