// Extra setup for the jsdom projects. It is listed after vitest.setup.ts, and Vitest runs afterEach hooks in reverse
// order, so Testing Library unmounts (cleanup) before leakCheck() looks for leaks.
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});
