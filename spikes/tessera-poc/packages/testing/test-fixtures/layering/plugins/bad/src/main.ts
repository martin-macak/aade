// A plugin that reaches into an implementation package: the fence must reject it (packages.md rule 5).
import { eventsThing } from '../../../packages/events/src/index.ts';
import { eventsModule } from '@tessera/events';
import { readFileSync } from 'node:fs';

export const bad: string = eventsThing + String(eventsModule) + String(readFileSync);
