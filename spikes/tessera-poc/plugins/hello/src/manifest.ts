import type { PluginManifest } from '@tessera/plugin-api';
import json from '../tessera-plugin.json' with { type: 'json' };

export const manifest: PluginManifest = json;
