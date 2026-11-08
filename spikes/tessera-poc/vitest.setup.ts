// Global Vitest setup, loaded before every test file of every package.
// - leakCheck() runs in afterEach of every suite (poc-plan claim C2, stage A exit criterion).
// - Errors sent to reportError() that no test captured fail the test that caused them.
import { afterEach, beforeEach } from 'vitest';
import { assertNoUnexpectedErrors, clearUnexpectedErrors, disposeTestScopes, leakCheck, resetLeakTracking, startLeakTracking, startStrictErrorTracking } from '@tessera/testing';

startLeakTracking();
startStrictErrorTracking();

beforeEach(() => {
  clearUnexpectedErrors();
  resetLeakTracking();
});

// Vitest runs afterEach hooks in reverse order of registration ("stack"), so a suite's own cleanup runs first.
afterEach(async () => {
  const problems: unknown[] = [];
  try {
    await disposeTestScopes(); // scopes made by createTestScope() end here, so tests need no cleanup code
  } catch (error) {
    problems.push(error);
  }
  try {
    leakCheck();
  } catch (error) {
    problems.push(error);
  }
  try {
    assertNoUnexpectedErrors();
  } catch (error) {
    problems.push(error);
  }
  if (problems.length === 1) throw problems[0];
  if (problems.length > 1) throw new AggregateError(problems, 'leakCheck and error checks failed');
});
