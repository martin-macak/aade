import type { Schema } from '@tessera/base';
import { KNOWN_CAPABILITY, RESERVED_POINT_IDS, type PluginManifest } from '@tessera/contracts';
import semver from 'semver';
import { z } from 'zod';

/**
 * Plugin id: dot-separated segments, at least two. Contracts 14.1 allows lower-case segments only; the POC also allows
 * camelCase after the first letter so that the planned id `sample.taskStats` is valid (see deviations.md).
 */
export const PLUGIN_ID_PATTERN: RegExp = /^[a-z][a-zA-Z0-9-]*(\.[a-z][a-zA-Z0-9-]*)+$/;

/** A real range: valid for semver, and not one of the spellings of "any version" ('*', 'x', '', '>=0.0.0 || *'). */
export function isRealRange(range: string): boolean {
  const normalized = semver.validRange(range.trim());
  return normalized !== null && normalized !== '*';
}

/** The activation events a manifest declares itself (the registry adds derived ones). */
export const KNOWN_ACTIVATION_EVENT: RegExp = /^(\*|onStartupFinished|onCommand:.+|onView:.+|onService:.+)$/;

/**
 * An entry path ("main", "ui"): relative to the plugin folder, a script file (.js, .mjs; dev entries may be .ts, .mts, .tsx, .jsx). No `..`, no leading slash or backslash, no scheme
 * ("https:", "file:", "data:"), no encoded dot or slash (%2e, %2f, %5c). The loader checks the resolved URL against the base URL again.
 */
export function isSafeEntryPath(path: string): boolean {
  if (path.length === 0 || path.length > 512) return false;
  if (path.startsWith('/') || path.startsWith('\\') || path.includes('\\')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false; // a scheme
  if (/%(2e|2f|5c)/i.test(path)) return false;
  if (path.split('/').some((segment) => segment === '..')) return false;
  if ([...path].some((ch) => ch.charCodeAt(0) < 32)) return false; // control characters
  // .js and .mjs are the release forms; the TypeScript and JSX forms are the dev entries that the dev server (Vite) compiles on the fly.
  return /\.(m?js|m?ts|[jt]sx)$/.test(path);
}
const entryPath = z.string().min(1).refine(isSafeEntryPath, { message: 'must be a relative script path (.js, .mjs, or a dev .ts/.tsx entry) inside the plugin folder (no "..", no leading slash, no scheme, no encoded dots or slashes)' });

const range = z.string().refine(isRealRange, { message: 'must be a real semver range; "*", "x" and "" are rejected' });
const tokenId = z.string().min(1);
const stringList = z.array(z.string().min(1));

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(PLUGIN_ID_PATTERN, { message: 'must look like "acme.tasks" (dot-separated segments, at least two)' }),
    name: z.string().min(1),
    version: z.string().refine((v) => semver.valid(v) !== null, { message: 'must be a semver version' }),
    description: z.string().optional(),
    publisher: z.string().optional(),
    engines: z.object({ tessera: range }),
    main: entryPath.optional(),
    ui: z.record(z.string(), entryPath).optional(),
    host: z.enum(['in-process', 'utility', 'worker']).optional(),
    trust: z
      .enum(['first-party', 'trusted', 'isolated'])
      .refine((value) => value !== 'isolated', { message: 'trust "isolated" is not supported: v1 has the in-process host only' })
      .optional(),
    activationEvents: z.array(z.string()).optional(), // unknown events are warnings, not errors (forward compatibility)
    dependencies: z.record(z.string(), range).optional(),
    requires: z.array(tokenId).optional(),
    optional: z.array(tokenId).optional(),
    provides: z.array(tokenId).optional(),
    capabilities: z.array(z.string()).optional(), // unknown capabilities are warnings: the host does not grant what it does not know
    apiProposals: stringList.optional(),
    contributionPoints: z
      .array(z.object({ id: z.string().min(1).refine((id) => !RESERVED_POINT_IDS.has(id), { message: 'is a reserved contribution point id (themes, icons)' }), description: z.string().optional() }).strict())
      .optional(),
    contributesTo: z.array(z.string().min(1)).optional(),
    l10n: z.unknown().optional(), // reserved, no effect in v1
    contributes: z.record(z.string(), z.array(z.unknown())).optional(),
  }) as unknown as Schema<PluginManifest>;

/** The top-level keys of the v1 manifest. A key that is not in this set is a warning (a newer plugin on an older host), never an error. */
const KNOWN_MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'id', 'name', 'version', 'description', 'publisher', 'engines', 'main', 'ui', 'host', 'trust', 'activationEvents', 'dependencies', 'requires', 'optional', 'provides', 'capabilities', 'apiProposals', 'contributionPoints', 'contributes', 'contributesTo', 'l10n',
]);

export type ManifestParse =
  | { readonly ok: true; readonly manifest: PluginManifest; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Validates untrusted JSON. Never throws. Strictness lives in the plugin build lint; the host reads forward: an unknown top-level key,
 * an unknown capability and an unknown activation event are warnings (`warnings`), and are dropped from the manifest the host uses.
 */
export function parseManifest(input: unknown): ManifestParse {
  const result = pluginManifestSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map((i) => `${i.path.length > 0 ? i.path.map(String).join('.') : '(root)'}: ${i.message}`),
    };
  }
  const warnings: string[] = [];
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!KNOWN_MANIFEST_KEYS.has(key)) warnings.push(`plugin.manifestWarning: unknown manifest key "${key}" is ignored`);
  const parsed = result.data;
  let manifest: PluginManifest = parsed;
  const unknownCapabilities = (parsed.capabilities ?? []).filter((c) => !KNOWN_CAPABILITY.test(c));
  const unknownEvents = (parsed.activationEvents ?? []).filter((e) => !KNOWN_ACTIVATION_EVENT.test(e));
  for (const capability of unknownCapabilities) warnings.push(`plugin.manifestWarning: unknown capability "${capability}" is ignored`);
  for (const event of unknownEvents) warnings.push(`plugin.manifestWarning: unknown activation event "${event}" is ignored`);
  if (unknownCapabilities.length > 0 || unknownEvents.length > 0) {
    manifest = {
      ...parsed,
      ...(parsed.capabilities ? { capabilities: parsed.capabilities.filter((c) => KNOWN_CAPABILITY.test(c)) } : {}),
      ...(parsed.activationEvents ? { activationEvents: parsed.activationEvents.filter((e) => KNOWN_ACTIVATION_EVENT.test(e)) } : {}),
    };
  }
  return { ok: true, manifest, warnings };
}
