import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { chromium } from 'playwright';
import { defineConfig } from 'vitest/config';

// Two Vitest projects:
//   jsdom    test/**/*.test.ts(x)           logic and React rendering without layout
//   browser  test/**/*.browser.test.tsx     real Chromium (Vitest Browser Mode + Playwright 1.65.0): real DockPanel layout
// LUMINO_BROWSER=0 skips the browser project.
const browserEnabled = process.env['LUMINO_BROWSER'] !== '0';

/**
 * The Chromium that Browser Mode launches. If the build that Playwright 1.65.0 expects is not installed, use the newest
 * headless shell that an earlier Playwright left in its cache, so the suite runs offline. LUMINO_CHROMIUM overrides both.
 * Returns undefined to let Playwright decide. (Same approach as the Tessera spike.)
 */
function chromiumExecutable(): string | undefined {
  const fromEnv = process.env['LUMINO_CHROMIUM'];
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // fall through to the cache scan
  }
  const cache =
    process.env['PLAYWRIGHT_BROWSERS_PATH'] ??
    join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache)
    .filter((d) => d.startsWith('chromium_headless_shell-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const shell of shells) {
    for (const inner of readdirSync(join(cache, shell))) {
      const candidate = join(cache, shell, inner, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}
const executablePath = browserEnabled ? chromiumExecutable() : undefined;

const common = { extends: false as const, oxc: { jsx: { runtime: 'automatic' as const } } };

export default defineConfig({
  test: {
    projects: [
      {
        ...common,
        test: { name: 'jsdom', environment: 'jsdom', include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], exclude: ['test/**/*.browser.test.tsx'], setupFiles: ['test/setup.jsdom.ts'], testTimeout: 10_000 },
      },
      ...(browserEnabled
        ? [
            {
              ...common,
              optimizeDeps: {
                include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@radix-ui/react-checkbox', '@radix-ui/react-popover', '@lumino/application', '@lumino/widgets', '@lumino/commands', '@lumino/coreutils', '@lumino/signaling', '@lumino/disposable', '@lumino/messaging'],
              },
              test: {
                name: 'browser',
                include: ['test/**/*.browser.test.tsx'],
                testTimeout: 20_000,
                browser: { enabled: true, headless: true, provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}), instances: [{ browser: 'chromium' as const }] },
              },
            },
          ]
        : []),
    ],
  },
});
