---
type: sources
title: "UI framework for the main application: sources"
status: final
created: "2026-11-08"
updated: "2026-11-08"
authors:
  - aade maintainers
---

# UI framework for the main application: sources

The register of every source that this research cites. Only
`research.sh source add` adds an entry. Each entry has the ID S<n>, and
other files cite it as a footnote.

## Register

### S1

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | Electron Releases |
| url | https://www.electronjs.org/docs/latest/tutorial/electron-timelines |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Electron supports the latest three stable major versions and releases a new major every 8 weeks. The oldest supported line gets security fixes only. |

### S2

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | utilityProcess API |
| url | https://www.electronjs.org/docs/latest/api/utility-process |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The utilityProcess API starts a child process with Node.js and message ports through the Chromium Services API. |

### S3

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | Process Sandboxing |
| url | https://www.electronjs.org/docs/latest/tutorial/sandbox |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Electron sandboxes renderer processes by default since version 20. A sandboxed renderer has no Node.js environment. |

### S4

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | Webview Versions |
| url | https://v2.tauri.app/reference/webview-versions/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Tauri renders with WebView2 on Windows, WKWebView on macOS and webkit2gtk on Linux. The macOS webview updates only with the operating system. |

### S5

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | Embedding External Binaries |
| url | https://v2.tauri.app/develop/sidecar/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A Tauri application adds a Node.js runtime only as a sidecar binary that is built for each target triple. |

### S6

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | Process Model |
| url | https://v2.tauri.app/concept/process-model/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The Rust core process has full operating system access and routes all IPC. Webview libraries are linked at run time and stay outside the executable. |

### S7

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | Develop Extensions |
| url | https://jupyterlab.readthedocs.io/en/stable/extension/extension_dev.html |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A plugin is the basic unit of extensibility in JupyterLab, and extensions supply nearly every function of the application. |

### S8

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | Differences between the repository and Visual Studio Code |
| url | https://github.com/microsoft/vscode/wiki/Differences-between-the-repository-and-Visual-Studio-Code |
| published | 2025-07-31 |
| accessed | 2026-11-08 |
| evidence | Code - OSS is MIT licensed and can be forked into a working editor. The Visual Studio Code product adds Microsoft code and marketplace access under a product licence. |

### S9

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | Source Code Organization |
| url | https://github.com/microsoft/vscode/wiki/Source-Code-Organization |
| published | 2025-10-11 |
| accessed | 2026-11-08 |
| evidence | The VS Code core has layers named base, platform, editor and workbench. The core passes services to clients through constructor injection, and extensions run in a separate host process. |

### S10

| Field | Value |
| --- | --- |
| kind | primary |
| author | Eclipse Theia project |
| title | Theia README, License section |
| url | https://github.com/eclipse-theia/theia/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Theia is licensed under EPL-2.0, with GPL-2.0 plus the Classpath exception as the secondary licence. |

### S11

| Field | Value |
| --- | --- |
| kind | primary |
| author | Eclipse Theia project |
| title | Services and Contributions |
| url | https://theia-ide.org/docs/services_and_contributions/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Theia wires its services and contribution points with the InversifyJS container. |

### S12

| Field | Value |
| --- | --- |
| kind | primary |
| author | smapiot |
| title | Piral introduction |
| url | https://docs.piral.io/guidelines/tutorials/01-introduction |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Piral builds micro frontends from an application shell and feature modules called pilets. |

### S13

| Field | Value |
| --- | --- |
| kind | primary |
| author | Backstage project |
| title | Frontend Extensions |
| url | https://backstage.io/docs/frontend-system/architecture/extensions |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A Backstage frontend app is a tree of extensions, joined by attachment points with typed inputs and outputs. |

### S14

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft patterns and practices |
| title | Smart Client - Composite UI Application Block |
| url | https://learn.microsoft.com/en-us/previous-versions/msp-n-p/ff648747(v=pandp.10) |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A retired page from December 2005 describes CAB as a reusable .NET 2.0 block that composes independently built parts into Windows Forms smart clients. |

### S15

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | Lumino application source |
| url | https://raw.githubusercontent.com/jupyterlab/lumino/main/packages/application/src/index.ts |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The Lumino Application class exposes a command registry and a shell, and it can register, activate, deactivate and deregister plugins. |

### S16

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | Lumino plugin registry source |
| url | https://raw.githubusercontent.com/jupyterlab/lumino/main/packages/coreutils/src/plugins.ts |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A Lumino plugin declares required, optional and provided tokens, deferred start and a deactivate hook. The registry rejects dependency cycles. |

### S17

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | Lumino DockPanel source |
| url | https://raw.githubusercontent.com/jupyterlab/lumino/main/packages/widgets/src/dockpanel.ts |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Lumino DockPanel saves and restores its layout. The source has no floating or pop-out panel API. |

### S18

| Field | Value |
| --- | --- |
| kind | primary |
| author | Prism Library |
| title | Prism LICENSE file |
| url | https://github.com/PrismLibrary/Prism/blob/master/LICENSE |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Prism needs a Community licence with a revenue and funding cap, or a paid Commercial licence. |

### S19

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | tsyringe README |
| url | https://github.com/microsoft/tsyringe/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | tsyringe needs experimental decorators and a Reflect polyfill. It offers child containers and disposes disposable instances with the container. |

### S20

| Field | Value |
| --- | --- |
| kind | primary |
| author | Jeff Hansen |
| title | Awilix README |
| url | https://github.com/jeffijoe/awilix/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Awilix offers proxy and classic injection modes, scoped containers and a container dispose call. |

### S21

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | dockview README |
| url | https://github.com/dockview/dockview/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | dockview lists layout serialization, floating groups, pop-out windows and tab and group docking as features. |

### S22

| Field | Value |
| --- | --- |
| kind | primary |
| author | InversifyJS project |
| title | Container API |
| url | https://inversify.io/docs/api/container/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | InversifyJS supports container hierarchies through a parent option and offers activation and deactivation handlers. The page does not mention a dispose method. |

### S23

| Field | Value |
| --- | --- |
| kind | primary |
| author | InversifyJS project |
| title | Container class source |
| url | https://raw.githubusercontent.com/inversify/monorepo/main/packages/container/libraries/container/src/container/services/Container.ts |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | A child container subscribes to the caches of its parent. The class offers unbindAll and has no dispose method. |

### S24

| Field | Value |
| --- | --- |
| kind | primary |
| author | React team |
| title | Versioning Policy |
| url | https://react.dev/community/versioning-policy |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | React follows semantic versioning and backports security fixes to every affected major version. |

### S25

| Field | Value |
| --- | --- |
| kind | primary |
| author | shadcn |
| title | shadcn/ui changelog |
| url | https://ui.shadcn.com/docs/changelog |
| published | 2026-10-01 |
| accessed | 2026-11-08 |
| evidence | New shadcn/ui components are available for Base UI, React Aria and Radix across the styles of the project. |

### S26

| Field | Value |
| --- | --- |
| kind | primary |
| author | WorkOS |
| title | Radix Primitives introduction |
| url | https://www.radix-ui.com/primitives/docs/overview/introduction |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Radix Primitives is an unstyled, accessible React component library that can be adopted incrementally. |

### S27

| Field | Value |
| --- | --- |
| kind | primary |
| author | MUI |
| title | Base UI quick start |
| url | https://base-ui.com/react/overview/quick-start |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Base UI provides unstyled React components in one package and uses portals for popups. |

### S28

| Field | Value |
| --- | --- |
| kind | primary |
| author | JetBrains |
| title | Embedded Browser (JCEF) |
| url | https://plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The IntelliJ Platform recommends Swing for plugin UI and treats embedded JCEF browsers as the exception. |

### S29

| Field | Value |
| --- | --- |
| kind | primary |
| author | Neutralinojs project |
| title | Neutralinojs introduction |
| url | https://neutralino.js.org/docs/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Neutralinojs does not bundle Chromium and uses the web browser library of the operating system. |

### S30

| Field | Value |
| --- | --- |
| kind | primary |
| author | Caplin |
| title | FlexLayout README |
| url | https://github.com/caplin/FlexLayout/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | FlexLayout is a layout manager for React with popout tabs, and React is its only dependency. |

### S31

| Field | Value |
| --- | --- |
| kind | primary |
| author | Nico Jansen |
| title | typed-inject README |
| url | https://github.com/nicojs/typed-inject/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | typed-inject checks the dependency graph at compile time without decorators, and child injectors dispose what they provided. |

### S32

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | Tauri README |
| url | https://github.com/tauri-apps/tauri/blob/dev/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The stable Tauri line renders through WRY, which uses the system webview of each platform. |

### S33

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | tauri-runtime-cef on Tauri 3 alpha, issue 16481 |
| url | https://github.com/tauri-apps/tauri/issues/16481 |
| published | 2026-11-07 |
| accessed | 2026-11-08 |
| evidence | A bug report shows tauri-runtime-cef at 3.0.0-alpha versions on the Tauri 3 alpha line. The runtime builds a CEF wrapper from source. |

### S34

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | npm registry entry for electron |
| url | https://registry.npmjs.org/electron |
| published | 2026-11-04 |
| accessed | 2026-11-08 |
| evidence | Version 45.2.3 was published on 2026-11-04 under the licence MIT. |

### S35

| Field | Value |
| --- | --- |
| kind | primary |
| author | React team |
| title | npm registry entry for react |
| url | https://registry.npmjs.org/react |
| published | 2026-10-14 |
| accessed | 2026-11-08 |
| evidence | Version 19.3.1 was published on 2026-10-14 under the licence MIT. |

### S36

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | npm registry entry for dockview-core |
| url | https://registry.npmjs.org/dockview-core |
| published | 2026-10-30 |
| accessed | 2026-11-08 |
| evidence | Version 8.8.3 was published on 2026-10-30 under the licence MIT. |

### S37

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | npm registry entry for @lumino/widgets |
| url | https://registry.npmjs.org/@lumino/widgets |
| published | 2026-10-08 |
| accessed | 2026-11-08 |
| evidence | Version 2.10.0 was published on 2026-10-08 under the licence BSD-3-Clause. |

### S38

| Field | Value |
| --- | --- |
| kind | primary |
| author | InversifyJS project |
| title | npm registry entry for inversify |
| url | https://registry.npmjs.org/inversify |
| published | 2026-11-07 |
| accessed | 2026-11-08 |
| evidence | Version 8.3.0 was published on 2026-11-07 under the licence MIT. |

### S39

| Field | Value |
| --- | --- |
| kind | primary |
| author | WorkOS |
| title | npm registry entry for radix-ui |
| url | https://registry.npmjs.org/radix-ui |
| published | 2026-10-12 |
| accessed | 2026-11-08 |
| evidence | Version 1.8.1 was published on 2026-10-12 under the licence MIT. |

### S40

| Field | Value |
| --- | --- |
| kind | primary |
| author | MUI |
| title | npm registry entry for @base-ui/react |
| url | https://registry.npmjs.org/@base-ui/react |
| published | 2026-10-09 |
| accessed | 2026-11-08 |
| evidence | Version 1.9.0 was published on 2026-10-09 under the licence MIT. |

### S41

| Field | Value |
| --- | --- |
| kind | primary |
| author | Caplin |
| title | npm registry entry for flexlayout-react |
| url | https://registry.npmjs.org/flexlayout-react |
| published | 2026-09-26 |
| accessed | 2026-11-08 |
| evidence | Version 0.11.1 was published on 2026-09-26 under the licence MIT. |

### S42

| Field | Value |
| --- | --- |
| kind | primary |
| author | Golden Layout project |
| title | npm registry entry for golden-layout |
| url | https://registry.npmjs.org/golden-layout |
| published | 2022-09-26 |
| accessed | 2026-11-08 |
| evidence | Version 2.6.0 was published on 2022-09-26 under the licence MIT. |

### S43

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | npm registry entry for tsyringe |
| url | https://registry.npmjs.org/tsyringe |
| published | 2025-04-16 |
| accessed | 2026-11-08 |
| evidence | Version 4.10.0 was published on 2025-04-16 under the licence MIT. |

### S44

| Field | Value |
| --- | --- |
| kind | primary |
| author | Eclipse Theia project |
| title | npm registry entry for @theia/core |
| url | https://registry.npmjs.org/@theia/core |
| published | 2026-11-05 |
| accessed | 2026-11-08 |
| evidence | Version 1.77.0 was published on 2026-11-05 under the licence EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0. |

### S45

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | GitHub commit list of electron/electron |
| url | https://api.github.com/repos/electron/electron/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 34 people other than bots. The top author made 44 of them. |

### S46

| Field | Value |
| --- | --- |
| kind | primary |
| author | React team |
| title | GitHub commit list of facebook/react |
| url | https://api.github.com/repos/facebook/react/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 67 people other than bots. The top author made 49 of them. |

### S47

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | GitHub commit list of dockview/dockview |
| url | https://api.github.com/repos/dockview/dockview/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 6 people other than bots. The top author made 261 of them. |

### S48

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | GitHub commit list of jupyterlab/lumino |
| url | https://api.github.com/repos/jupyterlab/lumino/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 4 people other than bots. The top author made 6 of them. |

### S49

| Field | Value |
| --- | --- |
| kind | primary |
| author | InversifyJS project |
| title | GitHub commit list of inversify/monorepo |
| url | https://api.github.com/repos/inversify/monorepo/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 4 people other than bots. The top author made 243 of them. |

### S50

| Field | Value |
| --- | --- |
| kind | primary |
| author | WorkOS |
| title | GitHub commit list of radix-ui/primitives |
| url | https://api.github.com/repos/radix-ui/primitives/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 39 people other than bots. The top author made 236 of them. |

### S51

| Field | Value |
| --- | --- |
| kind | primary |
| author | MUI |
| title | GitHub commit list of mui/base-ui |
| url | https://api.github.com/repos/mui/base-ui/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 29 people other than bots. The top author made 50 of them. |

### S52

| Field | Value |
| --- | --- |
| kind | primary |
| author | Wails project |
| title | Wails README |
| url | https://github.com/wailsapp/wails/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Wails wraps Go code and a web frontend into one binary. |

### S53

| Field | Value |
| --- | --- |
| kind | primary |
| author | NW.js project |
| title | NW.js README |
| url | https://github.com/nwjs/nw.js/blob/nw90/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | NW.js is an application runtime based on Chromium and Node.js, and it calls Node.js modules directly from the DOM. |

### S54

| Field | Value |
| --- | --- |
| kind | primary |
| author | Apache NetBeans project |
| title | Apache NetBeans README |
| url | https://github.com/apache/netbeans/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Apache NetBeans is an open source development environment and application framework that builds with Java and Ant. |

### S55

| Field | Value |
| --- | --- |
| kind | primary |
| author | Eclipse Platform project |
| title | Eclipse Platform UI README |
| url | https://github.com/eclipse-platform/eclipse.platform.ui/blob/master/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The Eclipse Platform UI forms part of the Eclipse Rich Client Platform and uses the Eclipse Public License 2.0. |

### S56

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | Security checklist |
| url | https://www.electronjs.org/docs/latest/tutorial/security |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The Electron security checklist requires context isolation, process sandboxing, IPC sender validation and a Content Security Policy. |

### S57

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | JupyterLab React guide |
| url | https://jupyterlab.readthedocs.io/en/stable/extension/virtualdom.html |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | JupyterLab wraps React components as Lumino widgets through the ReactWidget class. |

### S58

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | GitHub repository metadata of microsoft/vscode |
| url | https://api.github.com/repos/microsoft/vscode |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | GitHub reports the licence of the Code - OSS repository as MIT. |

### S59

| Field | Value |
| --- | --- |
| kind | primary |
| author | NW.js project |
| title | GitHub commit list of nwjs/nw.js |
| url | https://api.github.com/repos/nwjs/nw.js/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 1 person other than bots. The top author made 128 of them. |

### S60

| Field | Value |
| --- | --- |
| kind | primary |
| author | Wails project |
| title | GitHub commit list of wailsapp/wails |
| url | https://api.github.com/repos/wailsapp/wails/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 8 people other than bots. The top author made 130 of them. |

### S61

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | GitHub commit list of tauri-apps/tauri |
| url | https://api.github.com/repos/tauri-apps/tauri/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 62 people other than bots. The top author made 88 of them. |

### S62

| Field | Value |
| --- | --- |
| kind | primary |
| author | Caplin |
| title | GitHub commit list of caplin/FlexLayout |
| url | https://api.github.com/repos/caplin/FlexLayout/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 1 person other than bots. The top author made 22 of them. |

### S63

| Field | Value |
| --- | --- |
| kind | primary |
| author | Golden Layout project |
| title | GitHub commit list of golden-layout/golden-layout |
| url | https://api.github.com/repos/golden-layout/golden-layout/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 0 people other than bots. The top author made 0 of them. |

### S64

| Field | Value |
| --- | --- |
| kind | primary |
| author | Jeff Hansen |
| title | GitHub commit list of jeffijoe/awilix |
| url | https://api.github.com/repos/jeffijoe/awilix/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 2 people other than bots. The top author made 8 of them. |

### S65

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | GitHub commit list of microsoft/tsyringe |
| url | https://api.github.com/repos/microsoft/tsyringe/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 1 person other than bots. The top author made 1 of them. |

### S66

| Field | Value |
| --- | --- |
| kind | primary |
| author | Jeff Hansen |
| title | npm registry entry for awilix |
| url | https://registry.npmjs.org/awilix |
| published | 2026-06-15 |
| accessed | 2026-11-08 |
| evidence | Version 13.0.5 was published on 2026-06-15 under the licence MIT. |

### S67

| Field | Value |
| --- | --- |
| kind | primary |
| author | Nico Jansen |
| title | npm registry entry for typed-inject |
| url | https://registry.npmjs.org/typed-inject |
| published | 2024-12-13 |
| accessed | 2026-11-08 |
| evidence | Version 5.0.0 was published on 2024-12-13 under the licence Apache-2.0. |

### S68

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | npm registry entry for @tauri-apps/api |
| url | https://registry.npmjs.org/@tauri-apps/api |
| published | 2026-10-14 |
| accessed | 2026-11-08 |
| evidence | Version 2.12.4 was published on 2026-10-14 under the licence Apache-2.0 OR MIT. |

### S69

| Field | Value |
| --- | --- |
| kind | primary |
| author | NW.js project |
| title | npm registry entry for nw |
| url | https://registry.npmjs.org/nw |
| published | 2026-10-23 |
| accessed | 2026-11-08 |
| evidence | Version 0.119.2 was published on 2026-10-23 under the licence MIT. |

### S70

| Field | Value |
| --- | --- |
| kind | primary |
| author | InversifyJS project |
| title | Getting started |
| url | https://inversify.io/docs/introduction/getting-started/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | InversifyJS installs with reflect-metadata, and classes take the injectable and inject decorators. |

### S71

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | dockview-core package page |
| url | https://www.npmjs.com/package/dockview-core |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | dockview-core is a layout manager for vanilla TypeScript, and it does not depend on other packages. Its README calls it an internal package and names dockview and dockview-react as the packages to install. |

### S72

| Field | Value |
| --- | --- |
| kind | primary |
| author | Golden Layout project |
| title | Golden Layout documentation |
| url | https://golden-layout.github.io/golden-layout/ |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | Golden Layout rearranges web page components with drag and drop, and its documentation lists saved layouts and popouts. |

### S73

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | LICENSES.chromium.html in the Electron 45.2.3 release |
| url | https://github.com/electron/electron/releases/tag/v45.2.3 |
| published | 2026-11-04 |
| accessed | 2026-11-08 |
| evidence | The licence file of the release has 498 entries. Of those, 17 mention the LGPL, including FFmpeg, and 3 others mention the GPL. |

### S74

| Field | Value |
| --- | --- |
| kind | primary |
| author | Microsoft |
| title | GitHub commit list of microsoft/vscode |
| url | https://api.github.com/repos/microsoft/vscode/commits |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | A sample of up to 300 commits since 2026-05-12 shows 40 people other than bots. The top author made 50 of them. |

### S75

| Field | Value |
| --- | --- |
| kind | primary |
| author | aade maintainers |
| title | GitHub Actions run of the Electron host smoke test |
| url | https://github.com/martin-macak/aade/actions/runs/42466657613 |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | The packaged smoke test reported every check as passed on windows-latest, ubuntu-latest and macos-latest. GitHub keeps run logs for a limited time. |

### S76

| Field | Value |
| --- | --- |
| kind | primary |
| author | Tauri project |
| title | crates.io entry for tauri-runtime-cef |
| url | https://crates.io/api/v1/crates/tauri-runtime-cef |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | The newest version of tauri-runtime-cef is 3.0.0-alpha.7, and the crate has no stable version. |

### S77

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | GitHub contributor list of dockview/dockview |
| url | https://api.github.com/repos/dockview/dockview/contributors |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | One account has 3,508 contributions. The next accounts other than bots have 104 and 26. |

### S78

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | dockview-core README on GitHub |
| url | https://github.com/dockview/dockview/blob/master/packages/dockview-core/README.md |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The README calls dockview-core an internal package and not a supported install target. |

### S79

| Field | Value |
| --- | --- |
| kind | primary |
| author | Electron project |
| title | GitHub release v45.2.3 |
| url | https://api.github.com/repos/electron/electron/releases/tags/v45.2.3 |
| published | 2026-11-04 |
| accessed | 2026-11-08 |
| evidence | GitHub lists release v45.2.3 with the publish date 2026-11-04. |

### S80

| Field | Value |
| --- | --- |
| kind | secondary |
| author | endoflife.date |
| title | Electron release and support dates |
| url | https://endoflife.date/api/electron.json |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | The list shows the latest three Electron major versions as still supported. |

### S81

| Field | Value |
| --- | --- |
| kind | primary |
| author | React team |
| title | GitHub release v19.3.1 |
| url | https://api.github.com/repos/facebook/react/releases/tags/v19.3.1 |
| published | 2026-10-14 |
| accessed | 2026-11-08 |
| evidence | GitHub lists release v19.3.1 with the publish date 2026-10-14. |

### S82

| Field | Value |
| --- | --- |
| kind | primary |
| author | React team |
| title | GitHub licence of facebook/react |
| url | https://api.github.com/repos/facebook/react/license |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | GitHub reports the licence of the React repository as MIT. |

### S83

| Field | Value |
| --- | --- |
| kind | primary |
| author | MUI |
| title | GitHub release v1.9.0 of Base UI |
| url | https://api.github.com/repos/mui/base-ui/releases/tags/v1.9.0 |
| published | 2026-10-09 |
| accessed | 2026-11-08 |
| evidence | GitHub lists Base UI release v1.9.0 with the publish date 2026-10-09. |

### S84

| Field | Value |
| --- | --- |
| kind | primary |
| author | MUI |
| title | GitHub licence of mui/base-ui |
| url | https://api.github.com/repos/mui/base-ui/license |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | GitHub reports the licence of the Base UI repository as MIT. |

### S85

| Field | Value |
| --- | --- |
| kind | primary |
| author | WorkOS |
| title | GitHub licence of radix-ui/primitives |
| url | https://api.github.com/repos/radix-ui/primitives/license |
| published | 2026-11-08 |
| accessed | 2026-11-08 |
| evidence | GitHub reports the licence of the Radix Primitives repository as MIT. |

### S86

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | dockview floating groups documentation |
| url | https://dockview.dev/docs/core/groups/floatingGroups |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The dockview documentation has a section on floating groups. |

### S87

| Field | Value |
| --- | --- |
| kind | primary |
| author | dockview project |
| title | dockview popout windows documentation |
| url | https://dockview.dev/docs/core/groups/popoutGroups |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The dockview documentation has a section on popout windows. |

### S88

| Field | Value |
| --- | --- |
| kind | primary |
| author | Project Jupyter |
| title | Lumino DockLayout source |
| url | https://raw.githubusercontent.com/jupyterlab/lumino/main/packages/widgets/src/docklayout.ts |
| published | unknown |
| accessed | 2026-11-08 |
| evidence | The Lumino DockLayout source has no code for floating or pop-out panels. |
