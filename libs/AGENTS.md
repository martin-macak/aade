# libs/

Shared code that modules and apps import. A library must not import
`modules/` or `apps/`, because shared code must not depend on its users.
`pnpm archTest` enforces this.

## Rules

- Give each library the name `@aade/<folder>`, and export its public API
  from `src/index.ts`. Other packages import that name and never a
  relative path, because the `exports` map of the package is its only
  stable surface.
- Copy the config files of an existing library for a new one. Its
  `package.json` needs the `lint` script, or Nx never lints it.
- Declare an internal dependency with `workspace:*`. Add an external
  dependency to the catalog in `pnpm-workspace.yaml` and declare it with
  `catalog:`, because the catalog allows one version per repository.
- Add each new dependency between projects to
  `tools/arch/architecture.puml`, or `pnpm archTest` fails.
