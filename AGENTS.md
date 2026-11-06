# AGENTS.md

Instructions for AI coding agents in this repository.
This file is the single source of truth. `CLAUDE.md`, `GEMINI.md` and
`.github/copilot-instructions.md` are symlinks to it.

## Project

aade. The purpose and the stack are not decided yet.
Update this section when they are.

## Setup

- Tools: [mise](https://mise.jdx.dev). Run `mise install`.
- [direnv](https://direnv.net) runs `mise install` through `.envrc`.

## Agent layout

Keep all agent configuration agent-agnostic.
Edit only the sources of truth. Never edit a symlink target through its link name.

| Source of truth | Consumers |
| --- | --- |
| `AGENTS.md` (any folder) | `CLAUDE.md`, `GEMINI.md` symlinks beside it; `.github/copilot-instructions.md` (root only) |
| `.agents/skills/` | Codex, Cursor, Gemini CLI, Copilot read it directly; `.claude/skills` is a symlink |
| `.agents/agents/` | `.claude/agents` is a symlink; Cursor reads `.claude/agents` |
| `.agents/mcp.json` | `.mcp.json`, `.cursor/mcp.json` symlinks; `.gemini/settings.json`, `.vscode/mcp.json`, `.codex/config.toml` generated |

Rules:

- To add folder-specific instructions, create `AGENTS.md` in that folder, then run `mise run agents:link`.
- Never create a real `CLAUDE.md` or `GEMINI.md`. Write to `AGENTS.md`.
- Put reusable workflows in `.agents/skills/<name>/SKILL.md` ([Agent Skills format](https://agentskills.io)).
- Put subagents in `.agents/agents/<name>.md` (Markdown with `name` and `description` frontmatter).
- Add MCP servers only to `.agents/mcp.json`. Use `command`/`args`/`env` for stdio or `url`/`headers` for HTTP. Then run `mise run agents:link`.
- Never put secrets in MCP config. Reference environment variables instead.
- Before you commit, run `mise run agents:check`. CI runs it too.

See `docs/agentic-setup.md` for details.

## Conventions

- Commit messages: [Conventional Commits](https://www.conventionalcommits.org), for example `chore(repository): add .envrc`.
- Keep history linear. Rebase, do not merge.
- Write prose in short, active sentences.
