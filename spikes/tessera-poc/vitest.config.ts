import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { chromium } from 'playwright';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));
const setupFile = join(root, 'vitest.setup.ts');
const domSetupFile = join(root, 'vitest.setup.dom.ts');

// One Vitest project per workspace package (the Vitest 5 replacement of vitest.workspace.ts), and up to three per package:
//   <name>          node       test/**/*.test.ts           (the default: core tests run in Node without a DOM)
//   <name>:jsdom    jsdom 31   test/**/*.test.tsx and test/**/*.dom.test.ts   (rendering tests with Testing Library)
//   <name>:browser  Chromium   test/**/*.browser.test.ts(x)  (Vitest Browser Mode with Playwright; TESSERA_BROWSER=0 skips them)
// Every test file gets the global setup: strict reported-error handling and leakCheck() in afterEach.
const browserEnabled = process.env['TESSERA_BROWSER'] !== '0';

/**
 * The Chromium that Browser Mode launches. Playwright 1.65 wants its own build. If that build is not installed (no
 * `playwright install` was run), use the newest headless shell that an earlier Playwright left in its cache; so the
 * suite runs offline. TESSERA_CHROMIUM overrides both. Returns undefined to let Playwright decide.
 */
function chromiumExecutable(): string | undefined {
  const fromEnv = process.env['TESSERA_CHROMIUM'];
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    // fall through to the cache scan
  }
  const cache = process.env['PLAYWRIGHT_BROWSERS_PATH'] ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
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

function filesOf(dir: string): string[] {
  const testDir = join(dir, 'test');
  if (!existsSync(testDir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(testDir);
  return out;
}

const isBrowser = (f: string): boolean => /\.browser\.test\.tsx?$/.test(f);
const isDom = (f: string): boolean => (/\.test\.tsx$/.test(f) || /\.dom\.test\.ts$/.test(f)) && !isBrowser(f);
const isNode = (f: string): boolean => /\.test\.ts$/.test(f) && !isBrowser(f) && !isDom(f);

type Project = Record<string, unknown>;

function projectsFor(group: string): Project[] {
  const base = join(root, group);
  if (!existsSync(base)) return [];
  const projects: Project[] = [];
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const files = filesOf(dir);
    const common = { extends: false as const, root: dir };
    const test = { setupFiles: [setupFile], testTimeout: 10_000 };
    if (files.some(isNode)) {
      projects.push({ ...common, test: { ...test, name: `${group}/${name}`, environment: 'node' as const, include: ['test/**/*.test.ts'], exclude: ['test/**/*.dom.test.ts', 'test/**/*.browser.test.ts'] } });
    }
    if (files.some(isDom)) {
      projects.push({
        ...common,
        test: { ...test, name: `${group}/${name}:jsdom`, environment: 'jsdom' as const, setupFiles: [setupFile, domSetupFile], include: ['test/**/*.test.tsx', 'test/**/*.dom.test.ts'], exclude: ['test/**/*.browser.test.tsx'] },
      });
    }
    if (browserEnabled && files.some(isBrowser)) {
      projects.push({
        ...common,
        oxc: { jsx: { runtime: 'automatic' } },
        // pre-bundle the dependencies the browser tests load, so that Vite does not re-optimize (and reload the page) in the middle of a cold run
        optimizeDeps: { include: ['dockview-core/dist/dockview-core.js', 'react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'zod', 'semver', '@preact/signals-core'] },
        test: {
          ...test,
          name: `${group}/${name}:browser`,
          include: ['test/**/*.browser.test.ts', 'test/**/*.browser.test.tsx'],
          browser: { enabled: true, headless: true, provider: playwright(executablePath ? { launchOptions: { executablePath } } : {}), instances: [{ browser: 'chromium' }] },
        },
      });
    }
  }
  return projects;
}

export default defineConfig({
  test: {
    projects: [...projectsFor('packages'), ...projectsFor('plugins'), ...projectsFor('apps')],
  },
});
