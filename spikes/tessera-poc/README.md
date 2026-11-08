# Tessera proof of concept

This folder contains the code of the experiment [Re-run of the Tessera proof of concept](../../docs/research/app-tech-stack/ui-framework/experiment-tessera-poc.md). Tessera is the working name of an application kernel on TypeScript, React and dockview, and the main application does not import this code.

## Commands

The code needs Node 26 or newer. Run each command through mise from this folder.

```bash
mise exec -- npm ci           # install the pinned dependencies
mise exec -- npm run build    # compile every package
mise exec -- npm run check    # typecheck, layer rules, API snapshots, lint and tests
mise exec -- npm run demo     # the demo app at http://localhost:5173
mise exec -- npm run bench    # the scale ladder
```

The `check:docs` step of `npm run check` skips itself, because the design documents stay outside this repository.

## Layout

| Path | Content |
| --- | --- |
| `packages/` | The kernel, services and adapters, one npm workspace per package |
| `plugins/` | Sample plugins |
| `apps/headless/` | Integration tests that boot the shell in Node |
| `apps/demo/` | The Vite demo app, described in its [README](apps/demo/README.md) |
| `api/` | Committed declaration snapshots of the public API |
| `bench/` | Performance probes |
| `scripts/` | Layer checks and helpers |

The layer rules are in `scripts/layers.json`, and `npm run check:layers` enforces them.
