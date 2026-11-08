// NEGATIVE FIXTURE (claim C1). Every import below breaks a layering rule; layering.test.ts expects the failures.
import { readFileSync } from 'node:fs';
import { commandsThing } from '../../commands/src/index.ts';
import { createElement } from 'react';

export const eventsThing: unknown = [readFileSync, commandsThing, createElement];
