import { describe, expect, it } from 'vitest';
import { NotificationService } from '@tessera/contracts';
import { createTestApp, describePlugin } from '@tessera/testing';
import plugin from '../src/main.ts';
import { manifest } from '../src/manifest.ts';

// The guide's "Hello plugin" (docs/6-guides/writing-a-plugin.md step 3a): the files of plugins/hello are the files of the guide, and this
// test runs them. A change to the guide that is not a change here fails the review of the guide.
describe('the Hello plugin of the guide (step 3a)', () => {
  it('activates on first use and answers the command', async () => {
    const description = describePlugin(manifest, 'builtin');
    const app = await createTestApp({ plugins: [description], modules: { [description.location]: () => plugin } });
    expect(app.plugins.status('acme.hello')?.state).toBe('resolved'); // declared, not loaded yet
    expect(await app.commands.execute('acme.hello.say')).toBe('hello');
    expect(app.plugins.status('acme.hello')?.state).toBe('active');
    expect(app.get(NotificationService).active.peek().some((n) => n.message === 'Hello from acme.hello' && n.source === 'acme.hello')).toBe(true);
  });
});
