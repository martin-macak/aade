// A plugin whose activation throws, after it already registered a handler. Used to show failure isolation and rollback.
import { type PluginManifest } from '../cap4-plugins.ts';

export const faultyPlugin: PluginManifest<void> = {
  id: 'sample.faulty',
  commands: [{ id: 'faulty.run', label: 'Run Faulty Plugin', menu: 'Tasks', palette: 'Tasks' }],
  activate(ctx) {
    ctx.handle('faulty.run', () => 'unreachable'); // registered, then rolled back when the next line throws
    throw new Error('sample.faulty failed to activate');
  },
};
