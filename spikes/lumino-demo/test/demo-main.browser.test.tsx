// Smoke test of the real demo entry (src/main.tsx) in Chromium: the page boots, shows two Tasks placements, and its buttons work.
import { vi, expect, it } from 'vitest';

it('demo: src/main.tsx boots in Chromium with two placements, a working fault button and a deactivate button', async () => {
  window.localStorage.clear();
  document.body.innerHTML = '<div id="app"></div>';
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  await import('../src/main.tsx');
  const win = (window as unknown as { luminoDemo: import('../src/app.ts').DemoWindow }).luminoDemo;
  await vi.waitFor(() => expect(document.querySelectorAll('section.tasks')).toHaveLength(2), { timeout: 10_000 });
  const buttons = Object.fromEntries([...document.querySelectorAll<HTMLButtonElement>('#toolbar button')].map((b) => [b.textContent, b]));
  expect(Object.keys(buttons)).toContain('Run faulty plugin');
  buttons['Run faulty plugin']!.click();
  await vi.waitFor(() => expect(win.plugins.state('sample.faulty')).toBe('failed'));
  expect(document.querySelectorAll('section.tasks')).toHaveLength(2); // the app is still alive
  buttons['Audit log']!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-testid="audit"]')).not.toBeNull());
  buttons['Deactivate tasks plugin']!.click(); // tasks was activated by creating the views
  await vi.waitFor(() => expect(win.plugins.state('sample.tasks')).toBe('inactive'));
  expect(document.querySelectorAll('section.tasks')).toHaveLength(0); // its views were closed with it
  // autosave wrote the layout that the page would restore
  expect(window.localStorage.getItem('lumino-demo.layout')).toContain('"format":1');
  expect(errors).toHaveBeenCalled(); // the faulty plugin's failure was logged, nothing else asserted here
  errors.mockRestore();
  win.dispose();
});
