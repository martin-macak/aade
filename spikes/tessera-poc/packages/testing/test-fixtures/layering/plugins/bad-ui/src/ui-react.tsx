// A UI entry with business logic: a run-time import from the plugin, the facade, a global document and the global window.
import { total } from './logic.ts';
import type { Row } from './logic.ts';
import { definePlugin } from '@tessera/plugin-api';
import { readFileSync } from 'node:fs';

export const sum = (rows: readonly Row[]): number => total(rows.map(() => 1));
export const title = document.title + String(window.innerWidth) + String(definePlugin) + String(readFileSync);
