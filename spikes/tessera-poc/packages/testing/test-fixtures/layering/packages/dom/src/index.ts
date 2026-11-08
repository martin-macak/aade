// A DOM helper package that imports React and dockview: only @tessera/react and @tessera/layout-dockview may.
import { createElement } from 'react';
import { createDockview } from 'dockview-core';

export const bad: unknown = [createElement, createDockview];
