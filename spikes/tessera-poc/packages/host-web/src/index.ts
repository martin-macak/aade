// @tessera/host-web: the browser host of the POC (contracts.md 17.4): localStorage backend, static plugin catalog and loader.
export { startWebApp } from './start-web-app.ts';
export type { StartWebAppOptions, WebApp, WebPlugin, WebRenderer } from './start-web-app.ts';
export { localStorageBackend } from './local-storage-backend.ts';
export type { LocalStorageBackend, LocalStorageBackendOptions } from './local-storage-backend.ts';
export { RETRY_PLUGIN, SHOW_COMMAND_PALETTE, webHostModule } from './web-module.ts';
