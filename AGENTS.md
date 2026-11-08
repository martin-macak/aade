# AGENTS.md

Instructions for AI coding agents in this repository. `CLAUDE.md` and
`GEMINI.md` are symlinks to this file, so edit only `AGENTS.md`. Nested
`AGENTS.md` files add the purpose and rules of their folders. Direct task
instructions take precedence.

## Project

aade. A TypeScript monorepo on pnpm and Nx. The purpose and the stack of
the main application are not decided yet.

## Constitution

- Keep this file small, because every line costs context in every task.
  Load the `knowledge-curator` skill before you add, move or edit any
  instruction, skill or doc.
- Skills in `.agents/skills/` hold the task rules. Load the matching skill
  before you start a task.
- Use decisionkit for closed decisions: yes/no checks, classification,
  scoring and ranking. Load the `decisionkit` skill first.
- Pin every tool to an exact version in `mise.toml`. Run tools and checks
  through mise, so every agent and CI use the same versions.
- Build, test and lint code with `pnpm build`, `pnpm test`, `pnpm lint`
  and `pnpm archTest`, because `mise run test` runs only the bats suites
  of the repository.
- Pre-commit is the quality gate. Never bypass it with `--no-verify`.
- Keep secrets, credentials and personal data out of commits, MCP config
  and external services such as decisionkit.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org).
- Keep history linear. Rebase, do not merge.
- Write prose in short, active sentences.
- Open GitHub issues and pull requests only through the forms, the
  template and the labels in `.github/`. Load the `issue-authoring` skill
  first. Load the `pr-shepherd` skill before you change, answer or merge
  a pull request.
