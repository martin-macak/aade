// A ui-* file may import @tessera/react/ui, but not the root entry.
import { useServices } from '@tessera/react';
import { defineReactUi } from '@tessera/react/ui';

export default defineReactUi([]);
export const alsoBad: unknown = useServices;
