import { definePlugin } from '@tessera/plugin-api';
import type { PluginModule } from '@tessera/plugin-api';

// The "Hello plugin" of docs/6-guides/writing-a-plugin.md step 3a. The explicit type on the default export is required by
// isolatedDeclarations (TS9037): without it a plugin author who copies the snippet into a package that has the option set gets an error.
const plugin: PluginModule = definePlugin({
  activate(ctx) {
    ctx.api.commands.registerHandler('acme.hello.say', {
      run() {
        ctx.api.window.notify({ severity: 'info', message: 'Hello from acme.hello' });
        return 'hello';
      },
    });
  },
});

export default plugin;
