import { reportError } from '@tessera/base';

/**
 * Fault isolation for rows that a plugin controls (menu items, status bar items): one row that throws while it is built (a bad `when`,
 * a throwing text observable) is reported once per guard and key, and skipped. The other rows still render.
 */
export function createRowGuard(details: Readonly<Record<string, unknown>>): (key: string, owner: string | undefined, build: () => void) => void {
  const reported = new Set<string>();
  return (key, owner, build) => {
    try {
      build();
    } catch (error) {
      if (reported.has(key)) return;
      reported.add(key);
      reportError(error, { source: 'command', target: key, ...(owner !== undefined ? { pluginId: owner } : {}), details });
    }
  };
}
