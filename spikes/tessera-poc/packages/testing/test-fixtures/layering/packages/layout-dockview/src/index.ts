// The owner of dockview-core may import it, and nothing else foreign: React is not its business.
import { createDockview } from 'dockview-core';
import { createElement } from 'react';

export const fine: unknown = createDockview;
export const bad: unknown = createElement;
