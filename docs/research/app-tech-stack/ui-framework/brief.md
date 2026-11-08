---
type: brief
title: "UI framework for the main application"
status: final
created: "2026-11-08"
updated: "2026-11-08"
authors:
  - aade maintainers
depth: deep
artifacts:
  - comparison
  - recommendation
  - tech-profile
  - experiment
---

# UI framework for the main application

The aade maintainers need this answer to pick the application framework and the UI stack before the main application gets its first code.

## Question

Which maintained, cross-platform stack should power the composable IDE of the main application, with CAB/SCSF-style composition and a React user interface?

Sub-questions:

- Is an existing composite application framework such as Lumino a better base than an own kernel on a docking library?
- Which desktop runtime carries that framework on macOS, Windows and Linux?
- Which docking and React component libraries fit the framework?
- What does each option cost us to own and to keep current?

## Background

The main application needs to be a cross-platform app with a rich composable IDE, something resembling the old Microsoft CAB/SCSF.

It has to support:

- dependency injection
- plugging
- composable user interface
- events
- commands
- workspaces
- workitems / unit-of-work

Requested in issue [#46](https://github.com/martin-macak/aade/issues/46).

The research reads a workitem as a use-case scope. The scope contains services, state, views and events. The research also reports whether an option can commit or discard the changes of a workitem as one unit.

A preliminary study from 6 and 7 November 2026 exists outside this repository. It holds a teardown of GitKraken Desktop and Kepler, a note on composite application frameworks, and the design and proof of concept of a framework called Tessera. This research uses the study as a starting hypothesis, and it reads every fact again at its origin. The study leaves these gaps:

- It assumes Electron, React and an own kernel, and it compares the runtime only with Tauri.
- It has no weighted comparison of an existing framework against an own kernel. Its framework note comes from model knowledge.
- Its proof of concept never starts Electron, and it ran only on macOS arm64.
- It does not weigh what a kernel costs to maintain. Its proof of concept has 48,145 lines.
- It does not define "maintained" or "SOLID" in a form that a check can test.

## Scope

### In scope

- Eclipse Theia as a design reference only. Its EPL-2.0 or GPL-2.0 licence fails the licence constraint.
- A fork of Code - OSS as a composite application framework, in the comparison without an experiment.
- Lumino with the JupyterLab plugin model.
- An own kernel on a docking library, with Tessera as its worked example.
- A screening of Piral, the Backstage frontend system, Prism on Avalonia, Eclipse RCP, the IntelliJ Platform and NetBeans against the hard constraints.
- Electron and Tauri as desktop runtimes, in depth.
- A screening of the desktop runtimes Wails, Neutralino and NW.js.
- Dependency injection options that the frameworks imply: InversifyJS, tsyringe, awilix, typed-inject and a small own container.
- Docking libraries: dockview, Lumino DockPanel, FlexLayout and Golden Layout.
- React 19 and the component libraries Radix UI, Base UI and shadcn/ui.
- An experiment that re-runs the Tessera proof of concept from a clean copy.
- An experiment with a minimal Electron host that starts on macOS, Windows and Linux.
- An experiment that builds the demo of the proof of concept on Lumino, with a JupyterLab-style plugin model.

### Out of scope

- The build, package, lint and test toolchain. It does not decide the framework, and a later child research can cover it.
- Agent protocols such as ACP and MCP. They concern product features, and a later research can cover them.
- Code editor and terminal components such as Monaco and xterm.js, except as a note on fit. They matter after the framework choice.
- The detailed design of an own kernel. A later design issue can cover it, if the comparison ranks that option first.
- GitKraken internals that only the installed apps reveal. This repository is public, and we did not check the licence terms of those apps.
- Mobile platforms. An IDE needs a desktop window and process model.

## Constraints

- The application runs on macOS, Windows and Linux desktops. A browser host is welcome and not required.
- An option that cannot host React views fails.
- An option provides dependency injection, plugins, composable UI, events, commands, workspaces and workitems. It provides each one built in, or with an amount of our own code that the comparison states.
- Each direct runtime dependency uses a permissive licence, such as MIT, Apache-2.0 or BSD. A copyleft licence or a paid licence fails. The research reports copyleft parts further down the dependency tree.
- The first release runs first-party plugins. Third-party plugins are a later goal, and the first release does not sandbox untrusted code.
- This repository is public. The research must not publish personal paths or material that we may not redistribute.

## Success criteria

- [ ] modern tech stack is found
  - Each chosen component is on a supported major version, and none is end of life.
- [ ] is based on maintained technologies
  - Each chosen component had a stable release in the last 6 months and has a published support or security policy.
  - Each chosen component has at least two active maintainers or a backing organisation. A component without them stays only behind a replaceable adapter.
- [ ] supports cross-platform
  - A packaged build starts on macOS, Windows and Linux in the Electron experiment. The report marks each platform without a run as unverified.
- [ ] supports SOLID patterns
  - The report checks single responsibility through module and class boundaries.
  - The report checks open/closed through contribution points.
  - The report checks Liskov substitution through adapter conformance suites.
  - The report checks interface segregation through narrow service contracts.
  - The report checks dependency inversion through injected abstractions and an enforced layer fence.
- [ ] supports dependency injection
  - The chosen container gives hierarchical scopes for application, window, workitem and view, multi-bindings and deterministic disposal.
- [ ] supports React and modern UI components
  - A React 19 view with a current component library renders inside a docked panel in an experiment.
- [ ] Each option has a verdict for each required capability, and the report states whether a workitem can commit or discard its changes as one unit.
- [ ] The comparison states what we must build and own for each option.
- [ ] Each experiment ends with a verdict of confirmed, refuted or inconclusive.

## Source policy

- Prefer primary sources. Official docs, release notes and package registries count as primary, and so does source code.
- Use vendor blogs and talks for context only.
- Use forums, personal blogs and AI summaries only to find leads. A key finding must not depend on them.
- The preliminary study is a lead as well. Each fact from it is read again at its origin, or the research marks it `(unverified)`.
- For GitKraken and Kepler, use only their public blog, docs and public repositories.
- A version, release or support fact counts only when the research reads it during this work and its source is under 12 months old. Sources on concepts, such as CAB and SCSF, can have any age.
- Each key finding has 2 sources that agree, and the research holds at least 10 sources.
