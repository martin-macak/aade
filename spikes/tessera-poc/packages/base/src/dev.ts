let devMode = true;

/** Dev mode turns on extra checks: deep-freeze of state values, topic payload validation, creation stacks. */
export function isDevMode(): boolean {
  return devMode;
}

/** The shell sets this from the host (`isDev`). The default is on, so tests and the POC run with checks. */
export function setDevMode(value: boolean): void {
  devMode = value;
}
