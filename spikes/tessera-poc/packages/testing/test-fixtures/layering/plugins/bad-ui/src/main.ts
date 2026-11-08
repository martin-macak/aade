// A plugin main entry must not import React (only the ui-* entries may).
import { createElement } from 'react';

export const element: unknown = createElement('div');
