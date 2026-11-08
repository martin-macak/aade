import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { playwright } from '@vitest/browser-playwright';
import { chromium } from 'playwright';
import { defineConfig } from 'vitest/config';

/**
 * The Chromium that Browser Mode launches. If the build that Playwright 1.65.0 expects is not installed, use the newest
 * headless shell that an earlier Playwright left in its cache, so the suite runs offline. SPIKE_CHROMIUM overrides both.
 * Returns undefined to let Playwright decide. (Same approach as the lumino-demo spike.)
 */
function chromiumExecutable(): string | undefined {
  const fromEnv = process.env['SPIKE_CHROMIUM'];
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
const executablePath = chromiumExecutable();

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  // Pre-bundle everything up front, so Browser Mode does not reload the page when it discovers a dependency mid-run.
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'radix-ui', '@base-ui/react/popover', '@base-ui/react/checkbox', 'dockview-core'],
  },
  test: {
    include: ['test/**/*.browser.test.tsx'],
    testTimeout: 20_000,
    browser: {
      enabled: true,
      headless: true,
      viewport: { width: 1280, height: 800 },
      provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}),
      instances: [{ browser: 'chromium' as const }],
    },
  },
});
