// A plugin main entry (not a ui-* file) must not import the React chrome or the UI surface.
import { useService } from '@tessera/react';
import { defineReactUi } from '@tessera/react/ui';

export const bad: unknown = [useService, defineReactUi];
