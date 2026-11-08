// NEGATIVE FIXTURE for claim C1. This file must NOT compile under tsconfig.l0-l3.json:
// the DOM lib is absent, so `document` and `HTMLElement` do not exist.
// packages/testing/test/layering.test.ts compiles it and asserts the failure.
export const body: unknown = document.body;
export function tag(element: HTMLElement): string {
  return element.tagName;
}
