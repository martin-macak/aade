# aade

Project purpose: to be decided.

## Getting started

1. Install [mise](https://mise.jdx.dev) and, optionally, [direnv](https://direnv.net).
2. Run `mise trust && mise run setup`. It installs the pinned tools, the
   Vale styles and the pre-commit hooks.
3. Set the decisionkit provider in `mise.local.toml`. Git ignores this file.

   ```toml
   [env]
   DECISIONKIT_PROVIDER = "jev"
   ```

4. Run `mise run agents:health` to verify the setup.

`mise run check` runs every check that CI runs. `mise tasks` lists all tasks.

## Working with AI agents

This repository is agent-agnostic. Read [AGENTS.md](AGENTS.md) and
[docs/agentic-setup.md](docs/agentic-setup.md). The
[knowledge-curator](.agents/skills/knowledge-curator/SKILL.md) skill
gives the home of each rule and fact.

## Issues and pull requests

Open issues through the forms. Each issue gets a `type:<x>` and a
`scope:<x>` label. [docs/github-taxonomy.md](docs/github-taxonomy.md)
explains the labels and their automation.
