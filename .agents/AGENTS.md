# .agents

The source of the agent configuration. Each agent reads it through
symlinks or generated files. `docs/agentic-setup.md` maps each agent.

- `skills/<name>/SKILL.md`: skills in the [Agent Skills format](https://agentskills.io).
  The `knowledge-curator` skill explains how to write and test one.
- `agents/<name>.md`: subagents. Markdown with `name` and `description`
  front matter. Only Claude Code and Cursor read them.
- `mcp.json`: MCP servers in the `mcpServers` schema. Use
  `command`/`args`/`env` for stdio, or `url`/`headers` for HTTP. Reference
  secrets as environment variables, never as values.

After you change `mcp.json` or add a nested `AGENTS.md`, run
`mise run agents:link`. It regenerates the configs of Codex, Gemini CLI
and VS Code, and it adds the symlinks.
