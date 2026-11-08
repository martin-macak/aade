---
type: recommendation
title: "Recommended stack for the main application"
status: review
created: "2026-11-08"
updated: "2026-11-08"
authors:
  - aade maintainers
---

# Recommended stack for the main application

The main application should use Electron 45 and React 19 with a reduced own kernel on dockview, because the own kernel ranks first with 3.80 of 5 points in the [framework comparison](comparison-composite-framework.md).

## Context

The main application needs a composable IDE in the style of Microsoft CAB[^S14] on macOS, Windows and Linux. The [brief](brief.md) requires dependency injection, plugins, composable UI, events, commands, workspaces and workitems, on maintained technology with React.

The permissive licence rule removes Eclipse Theia[^S10][^S44]. The first release runs first-party plugins only. The [framework comparison](comparison-composite-framework.md) ranks the remaining options, and four experiments test them.

## Options considered

- **Own kernel on dockview.** It has test evidence for each required capability and for floating docking. Its main cost is 48,363 lines to maintain in the proof of concept.
- **Lumino with a small own kernel.** It gives docking, menus and a palette natively. Its main cost is our own mechanism for 7 of the 9 tested capabilities, and it has no floating panels[^S17].
- **Fork of Code - OSS.** It gives a proven workbench under the MIT licence[^S8]. Its main cost is a fork to keep current, with a UI that is not built on React (unverified).
- **Tauri in place of Electron.** It gives a small package[^S6]. Its main cost is a different webview on each platform[^S4] and a sidecar for a Node.js plugin host[^S5].

## Decision

- We use Electron 45 as the runtime, because it alone is stable with one rendering engine and a Node.js process model[^S1][^S2].
- We use React 19 for views, because the brief requires it and it has a published security backport policy[^S24].
- We build an own kernel on dockview, because it alone combines every required capability with floating and pop-out docking[^S21].
- We start from a reduced version of the Tessera proof of concept, because the full code base is too large to maintain for a first release.
- We use a small own dependency injection container, because no maintained library gives scopes, multi-bindings and disposal together, as the [DI comparison](comparison-di.md) shows.
- We depend on the `dockview` or `dockview-react` package behind an adapter, because `dockview-core` is an internal package[^S71] and one person made most of the commits[^S47].
- We set `isolation: isolate` on the dock host, because popups in floating groups are hidden without a stacking rule, as the [UI kit experiment](experiment-dockview-ui-kit.md) shows.
- We use Base UI behind a thin internal kit, because its commits are spread across more people than those of Radix[^S50][^S51]. Radix stays the alternative, and both passed the same tests.

## Consequences

Easier:

- Tests run without Electron or a browser for the kernel, as the [Tessera re-run](experiment-tessera-poc.md) shows.
- A docking, runtime or renderer change stays inside one adapter package.
- Popups, focus and docking have tested behaviour with two component libraries.

Harder:

- We maintain the kernel ourselves. This is the largest cost of the decision.
- Electron releases a new major every 8 weeks[^S1], so upgrades are constant work.
- The application includes Chromium and Node.js, so the package is large.

New risks:

- A reduced kernel may lose the qualities that the full proof of concept tested.
- dockview depends mainly on one person[^S47].
- The plugin host is not sandboxed by the operating system, so third-party plugins need a separate design.
- The Chromium licence file lists LGPL components[^S73]. A legal review is needed before distribution.

## Follow-up

- Open a design issue that reduces the kernel scope for the first release. The plugin gate, capability checks and RPC can wait, because the first release runs first-party plugins only.
- Split `workbench-service.ts` and remove the 17 downcasts to concrete classes in that design.
- Decide whether a workitem needs commit and discard as one unit, because the candidates don't guarantee this today.
- Move from `dockview-core` to a supported dockview package.
- Test pop-out windows under Electron, because no experiment covered them.
- Make the layer check tools work on Windows, where 9 of their tests fail on file paths.
- Get a legal review of the Chromium licence file.
- Run a child research for the build, package, lint and test toolchain.
- Re-check Tauri when its CEF runtime has a stable release[^S33].
- Re-check Theia if the licence rule changes.

[^S1]: [S1](sources.md#s1) Electron project, Electron Releases.
[^S2]: [S2](sources.md#s2) Electron project, utilityProcess API.
[^S4]: [S4](sources.md#s4) Tauri project, Webview Versions.
[^S5]: [S5](sources.md#s5) Tauri project, Embedding External Binaries.
[^S6]: [S6](sources.md#s6) Tauri project, Process Model.
[^S8]: [S8](sources.md#s8) Microsoft, Differences between the repository and Visual Studio Code.
[^S10]: [S10](sources.md#s10) Eclipse Theia project, Theia README, License section.
[^S14]: [S14](sources.md#s14) Microsoft patterns and practices, Smart Client - Composite UI Application Block.
[^S17]: [S17](sources.md#s17) Project Jupyter, Lumino DockPanel source.
[^S21]: [S21](sources.md#s21) dockview project, dockview README.
[^S24]: [S24](sources.md#s24) React team, Versioning Policy.
[^S33]: [S33](sources.md#s33) Tauri project, tauri-runtime-cef on Tauri 3 alpha, issue 16481.
[^S44]: [S44](sources.md#s44) Eclipse Theia project, npm registry entry for @theia/core.
[^S47]: [S47](sources.md#s47) dockview project, GitHub commit list of dockview/dockview.
[^S50]: [S50](sources.md#s50) WorkOS, GitHub commit list of radix-ui/primitives.
[^S51]: [S51](sources.md#s51) MUI, GitHub commit list of mui/base-ui.
[^S71]: [S71](sources.md#s71) dockview project, dockview-core package page.
[^S73]: [S73](sources.md#s73) Electron project, LICENSES.chromium.html in the Electron 45.2.3 release.
