# tools/arch

The repo-level architecture rules. `pnpm archTest` runs them in the
pre-commit hook and in CI. They keep the design stable while many agents
change the code in parallel.

## Rules

- Never weaken a rule, add an exemption or edit
  `tools/arch/architecture.puml` only to make `archTest` pass, because the
  next agent then inherits the bad design. Add a line to the diagram only
  when the design needs that dependency.
- Write a diagram line with the exact project names in brackets on both
  sides of the arrow. ArchUnitTS compares that text with the project name.
  An alias does not match, and the rule fails.
- Keep `tsconfig` values to those that TypeScript 5.9 knows. ArchUnitTS
  reads `tsconfig` with its own TypeScript 5.9, and a newer value, such as
  a `target` of `es2025`, makes the file rules fail.
- Prove a new rule on a real violation before you commit it. A rule can
  pass without checking anything, because ArchUnitTS treats a file that it
  cannot read as empty.
