import type { PluginManifest } from '@tessera/plugin-api';
import json from '../tessera-plugin.json' with { type: 'json' };

/** The manifest, read from tessera-plugin.json (the one source of truth). */
export const manifest: PluginManifest = json;
