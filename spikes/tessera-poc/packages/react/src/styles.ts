/** The default stylesheet of the React adapter. Hosts may replace it (injectStyles: false) and style the tessera-* classes. */
export const defaultStyles: string = `
:root {
  --tessera-bg: #f6f7f9; --tessera-surface: #ffffff; --tessera-surface-2: #eef0f4; --tessera-border: #d5d9e0;
  --tessera-text: #1b1f27; --tessera-muted: #5c6575; --tessera-accent: #2457d6; --tessera-accent-text: #ffffff;
  --tessera-error: #b3261e; --tessera-warn: #8a5a00; --tessera-ok: #1f7a3d; --tessera-focus: #2457d6;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --tessera-bg: #14171c; --tessera-surface: #1c2027; --tessera-surface-2: #252a33; --tessera-border: #343b47;
    --tessera-text: #e6e9ef; --tessera-muted: #9aa4b5; --tessera-accent: #6d93ff; --tessera-accent-text: #0d1220;
    --tessera-error: #ff8a80; --tessera-warn: #f3c46b; --tessera-ok: #7bd49a; --tessera-focus: #6d93ff;
  }
}
html, body { height: 100%; margin: 0; }
body { background: var(--tessera-bg); color: var(--tessera-text); font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; }
.tessera-workbench { display: grid; grid-template-rows: auto 1fr auto; height: 100vh; min-height: 0; }
.tessera-titlebar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: var(--tessera-surface); border-bottom: 1px solid var(--tessera-border); }
.tessera-app-title { font-weight: 600; letter-spacing: .02em; }
.tessera-palette-button { margin-left: auto; }
.tessera-main { display: flex; min-height: 0; }
.tessera-activitybar { display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--tessera-surface-2); border-right: 1px solid var(--tessera-border); }
.tessera-activitybar button { width: 32px; height: 32px; border-radius: 6px; font-weight: 600; }
.tessera-activitybar button[aria-pressed="true"] { background: var(--tessera-accent); color: var(--tessera-accent-text); border-color: var(--tessera-accent); }
.tessera-sidebar { width: 300px; min-width: 200px; background: var(--tessera-surface); border-right: 1px solid var(--tessera-border); overflow: auto; }
.tessera-sidebar-secondary { border-right: 0; border-left: 1px solid var(--tessera-border); }
.tessera-center { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.tessera-editor { flex: 1; min-height: 0; position: relative; }
.tessera-panel { height: 200px; border-top: 1px solid var(--tessera-border); background: var(--tessera-surface); overflow: auto; }
.tessera-dock { position: absolute; inset: 0; }
.tessera-tabs, .tessera-accordion { display: flex; flex-direction: column; height: 100%; }
.tessera-tablist { display: flex; gap: 2px; padding: 4px 4px 0; border-bottom: 1px solid var(--tessera-border); background: var(--tessera-surface-2); }
.tessera-tab { display: inline-flex; align-items: center; border: 1px solid transparent; border-bottom: 0; border-radius: 6px 6px 0 0; }
.tessera-tab button { border: 0; background: transparent; }
.tessera-tab-close { opacity: .6; padding: 2px 6px; }
.tessera-tabpanel { flex: 1; min-height: 0; overflow: auto; }
.tessera-pane { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.tessera-pane-title { display: flex; align-items: center; gap: 8px; padding: 4px 8px; font-weight: 600; background: var(--tessera-surface-2); border-bottom: 1px solid var(--tessera-border); }
.tessera-pane-label { flex: 1; }
.tessera-toolbar, .tessera-menu-group { display: inline-flex; gap: 4px; }
.tessera-placement { flex: 1; min-height: 0; overflow: auto; outline: none; }
.tessera-view { height: 100%; }
.tessera-placeholder, .tessera-error, .tessera-loading, .tessera-empty { margin: 12px; padding: 10px 12px; border: 1px dashed var(--tessera-border); border-radius: 8px; color: var(--tessera-muted); }
.tessera-error { border-style: solid; border-color: var(--tessera-error); color: var(--tessera-error); }
.tessera-error pre { white-space: pre-wrap; margin: 6px 0; }
.tessera-statusbar { display: flex; justify-content: space-between; gap: 12px; padding: 2px 10px; background: var(--tessera-accent); color: var(--tessera-accent-text); font-size: 12px; }
.tessera-statusbar .tessera-status-item { background: transparent; border: 0; color: inherit; padding: 0 6px; }
.tessera-status-left, .tessera-status-right { display: flex; gap: 4px; }
button { font: inherit; color: inherit; background: var(--tessera-surface); border: 1px solid var(--tessera-border); border-radius: 6px; padding: 3px 9px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--tessera-accent); }
button:disabled { opacity: .45; cursor: default; }
:focus-visible { outline: 2px solid var(--tessera-focus); outline-offset: 1px; }
input[type="text"], input:not([type]) { font: inherit; color: inherit; background: var(--tessera-surface); border: 1px solid var(--tessera-border); border-radius: 6px; padding: 4px 8px; }
.tessera-quickinput-backdrop { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; background: rgba(0,0,0,.25); z-index: 1000; }
.tessera-quickinput { width: min(560px, 92vw); background: var(--tessera-surface); border: 1px solid var(--tessera-border); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.35); overflow: hidden; }
.tessera-quickinput input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--tessera-border); border-radius: 0; padding: 10px 12px; font-size: 14px; }
.tessera-quickinput ul { list-style: none; margin: 0; padding: 4px; max-height: 320px; overflow: auto; }
.tessera-quickinput li { display: flex; gap: 8px; align-items: baseline; padding: 6px 8px; border-radius: 6px; cursor: pointer; }
.tessera-quickinput li.tessera-qi-active { background: var(--tessera-accent); color: var(--tessera-accent-text); }
.tessera-qi-description { opacity: .7; font-size: 12px; }
.tessera-qi-detail { margin-left: auto; font-size: 11px; opacity: .8; }
.tessera-qi-empty { color: var(--tessera-muted); cursor: default; }
.tessera-dialog-backdrop { position: fixed; inset: 0; display: flex; align-items: flex-start; justify-content: center; padding-top: 12vh; background: rgba(0, 0, 0, 0.35); z-index: 1200; }
.tessera-dialog { display: flex; flex-direction: column; gap: 8px; width: min(420px, 92vw); padding: 16px; border-radius: 8px; background: var(--tessera-panel, #fff); color: var(--tessera-fg, #111); box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3); }
.tessera-dialog-title { margin: 0; font-size: 1.05em; }
.tessera-dialog-message, .tessera-dialog-detail { margin: 0; }
.tessera-dialog-error { color: #b00020; font-size: 0.9em; }
.tessera-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.tessera-notifications { position: fixed; right: 12px; bottom: 36px; display: flex; flex-direction: column; gap: 8px; width: min(360px, 92vw); z-index: 1100; }
.tessera-notification { display: flex; gap: 8px; justify-content: space-between; padding: 10px 12px; background: var(--tessera-surface); border: 1px solid var(--tessera-border); border-left-width: 4px; border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
.tessera-notification-error { border-left-color: var(--tessera-error); }
.tessera-notification-warning { border-left-color: var(--tessera-warn); }
.tessera-notification-info { border-left-color: var(--tessera-accent); }
.tessera-notification-detail, .tessera-notification-source { color: var(--tessera-muted); font-size: 12px; }
.tessera-notification-actions { display: flex; flex-direction: column; gap: 4px; }
.dv-tessera-tab { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; height: 100%; }
.dv-tessera-tab button { border: 0; background: transparent; padding: 0 4px; opacity: .65; }
.tessera-dock-placeholder { padding: 12px; color: var(--tessera-muted); }
`;
