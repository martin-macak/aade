import { describe, expect, it } from 'vitest';
import { PluginLoader } from '@tessera/contracts';
import { renderCounterApp } from './app-kit.tsx';

// hot-reload-stale-modules: the mounter drops the cached ui entry of a plugin when the plugin ends, so a reload imports it again.
describe('React mounter: the ui entry cache follows the plugin', () => {
  it('drops the view definitions of a plugin on reload and imports the ui entry again', async () => {
    let imports = 0;
    const view = await renderCounterApp();
    // count the imports of the ui entry
    const catalogLoader = view.app.application.get(PluginLoader);
    const original = catalogLoader.load.bind(catalogLoader);
    (catalogLoader as { load: typeof catalogLoader.load }).load = async (description, entry) => {
      if (entry === 'react') imports++;
      return original(description, entry);
    };
    const mounter = view.renderer.mounter;
    expect(await mounter.ensureUi('counter.view')).toBe(true);
    expect(imports).toBe(1);
    expect(await mounter.ensureUi('counter.view')).toBe(true);
    expect(imports).toBe(1); // cached
    await view.app.plugins.activate('test.counter');
    await view.app.plugins.reload('test.counter');
    expect(mounter.canMount('counter.view')).toBe(false); // dropped when the plugin ended
    expect(await mounter.ensureUi('counter.view')).toBe(true);
    expect(imports).toBe(2); // imported again
    view.unmount();
  });

  it('keeps definitions that were registered directly', async () => {
    const view = await renderCounterApp();
    const mounter = view.renderer.mounter;
    const registration = mounter.register([{ viewType: 'direct.view', rendererId: 'react', component: () => null } as never]);
    mounter.forgetUi('test.counter');
    expect(mounter.canMount('direct.view')).toBe(true);
    registration.dispose();
    view.unmount();
  });
});
