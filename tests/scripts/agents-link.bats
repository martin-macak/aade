#!/usr/bin/env bats

# scripts/agents-link.sh keeps one source of truth for every agent tool.
# AGENTS.md, .agents/skills, .agents/agents and .agents/mcp.json hold the
# content. Each tool gets an entry point: a symlink where it reads the same
# format, a rendered file where it does not. The script repairs the layout.
# With --check it only reports drift, and the pre-commit hook uses that.

bats_require_minimum_version 1.5.0

load helpers/common

setup() {
	sandbox agents-link.sh
	S=scripts/agents-link.sh
	mcp_fixture
}

# The MCP source: a stdio server, a remote server with headers and a
# remote server with only a URL. Together they reach every render branch.
mcp_fixture() {
	fixture .agents/mcp.json <<'EOF'
{
  "mcpServers": {
    "local.tool": {
      "command": "npx",
      "args": ["-y", "tool"],
      "env": {"TOKEN": "abc", "MODE": "fast"}
    },
    "remote": {
      "type": "http",
      "url": "https://remote.example.com/mcp",
      "headers": {"Authorization": "Bearer x"}
    },
    "plain": {
      "url": "https://plain.example.com/mcp"
    }
  }
}
EOF
}

# Print one line per path of the sandbox: its link target or its checksum.
# Two equal prints mean that nothing changed.
state() {
	find . -name .git -prune -o -print | sort | while read -r p; do
		if [ -L "$p" ]; then
			echo "$p -> $(readlink "$p")"
		elif [ -d "$p" ]; then
			echo "$p/"
		else
			echo "$p $(cksum <"$p")"
		fi
	done
}

# Pass when the file $1 holds exactly the text of stdin.
file_is() {
	cat >"$BATS_TEST_TMPDIR/want"
	cmp -s "$BATS_TEST_TMPDIR/want" "$1" || {
		diff "$BATS_TEST_TMPDIR/want" "$1" >&2
		return 1
	}
}

# Bring the sandbox into the linked state, without checking the output.
link_all() {
	fixture AGENTS.md <<<"root rules"
	"$S" >/dev/null
}

# --- link mode: context files ---

@test "link: creates CLAUDE.md and GEMINI.md beside every AGENTS.md, nested ones too" {
	fixture AGENTS.md <<<"root rules"
	fixture docs/api/AGENTS.md <<<"nested rules"
	run "$S"
	[ "$status" -eq 0 ]
	for d in . docs/api; do
		[ "$(readlink "$d/CLAUDE.md")" = AGENTS.md ]
		[ "$(readlink "$d/GEMINI.md")" = AGENTS.md ]
	done
	[ "$(cat docs/api/CLAUDE.md)" = "nested rules" ]
	has "$output" "linked: ./CLAUDE.md -> AGENTS.md"
	has "$output" "linked: ./docs/api/GEMINI.md -> AGENTS.md"
}

@test "link: skips .git, node_modules, .direnv and .venv at any depth" {
	# A real CLAUDE.md beside an AGENTS.md is an error outside these folders.
	# So a passing run proves that the script never looked inside.
	for d in .git/x node_modules/x .direnv/x .venv/x packages/app/node_modules/x; do
		fixture "$d/AGENTS.md" <<<"vendored"
		fixture "$d/CLAUDE.md" <<<"vendored, real file"
	done
	run "$S"
	[ "$status" -eq 0 ]
	for d in .git/x node_modules/x .direnv/x .venv/x packages/app/node_modules/x; do
		[ ! -e "$d/GEMINI.md" ]
		[ -f "$d/CLAUDE.md" ]
		[ ! -L "$d/CLAUDE.md" ]
		lacks "$output" "$d"
	done
}

@test "link: creates only what is missing" {
	fixture AGENTS.md <<<"root rules"
	ln -s AGENTS.md CLAUDE.md
	run "$S"
	[ "$status" -eq 0 ]
	has "$output" "linked: ./GEMINI.md -> AGENTS.md"
	lacks "$output" "linked: ./CLAUDE.md"
}

@test "link: works from any directory, because the script finds the repository itself" {
	fixture AGENTS.md <<<"root rules"
	mkdir elsewhere
	cd elsewhere
	run ../scripts/agents-link.sh
	[ "$status" -eq 0 ]
	[ "$(readlink "$SANDBOX/CLAUDE.md")" = AGENTS.md ]
	[ ! -e CLAUDE.md ]
}

# --- link mode: skills, subagents and MCP links ---

@test "link: links .claude/skills and .claude/agents to the shared folders" {
	fixture .agents/skills/demo/SKILL.md <<<"a skill"
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(readlink .claude/skills)" = ../.agents/skills ]
	[ "$(readlink .claude/agents)" = ../.agents/agents ]
	[ "$(cat .claude/skills/demo/SKILL.md)" = "a skill" ]
	has "$output" "linked: .claude/skills -> ../.agents/skills"
	has "$output" "linked: .claude/agents -> ../.agents/agents"
}

@test "link: links .mcp.json and .cursor/mcp.json to the MCP source" {
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(readlink .mcp.json)" = .agents/mcp.json ]
	[ "$(readlink .cursor/mcp.json)" = ../.agents/mcp.json ]
	cmp .agents/mcp.json .mcp.json
	cmp .agents/mcp.json .cursor/mcp.json
}

# --- link mode: rendered MCP files ---

@test "link: renders .gemini/settings.json, with httpUrl for remote servers" {
	run "$S"
	[ "$status" -eq 0 ]
	[ ! -L .gemini/settings.json ]
	file_is .gemini/settings.json <<'EOF'
{
  "mcpServers": {
    "local.tool": {
      "command": "npx",
      "args": [
        "-y",
        "tool"
      ],
      "env": {
        "TOKEN": "abc",
        "MODE": "fast"
      }
    },
    "remote": {
      "httpUrl": "https://remote.example.com/mcp",
      "headers": {
        "Authorization": "Bearer x"
      }
    },
    "plain": {
      "httpUrl": "https://plain.example.com/mcp"
    }
  }
}
EOF
	has "$output" "rendered: .gemini/settings.json"
}

@test "link: renders .vscode/mcp.json, with the servers key and a type on every server" {
	run "$S"
	[ "$status" -eq 0 ]
	[ ! -L .vscode/mcp.json ]
	file_is .vscode/mcp.json <<'EOF'
{
  "servers": {
    "local.tool": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "tool"
      ],
      "env": {
        "TOKEN": "abc",
        "MODE": "fast"
      }
    },
    "remote": {
      "type": "http",
      "url": "https://remote.example.com/mcp",
      "headers": {
        "Authorization": "Bearer x"
      }
    },
    "plain": {
      "type": "http",
      "url": "https://plain.example.com/mcp"
    }
  }
}
EOF
	has "$output" "rendered: .vscode/mcp.json"
}

@test "link: renders .codex/config.toml as TOML tables with quoted names" {
	run "$S"
	[ "$status" -eq 0 ]
	[ ! -L .codex/config.toml ]
	file_is .codex/config.toml <<'EOF'
# Generated from .agents/mcp.json by scripts/agents-link.sh. Do not edit.

[mcp_servers."local.tool"]
command = "npx"
args = ["-y","tool"]
env = { "TOKEN" = "abc", "MODE" = "fast" }

[mcp_servers."remote"]
url = "https://remote.example.com/mcp"
http_headers = { "Authorization" = "Bearer x" }

[mcp_servers."plain"]
url = "https://plain.example.com/mcp"
EOF
	has "$output" "rendered: .codex/config.toml"
}

@test "link: Gemini gets url for an SSE server, and httpUrl for other remote servers" {
	fixture .agents/mcp.json <<'EOF'
{"mcpServers": {
  "events": {"type": "sse", "url": "https://events.example.com/sse", "headers": {"A": "b"}},
  "stream": {"type": "http", "url": "https://stream.example.com/mcp"},
  "plain": {"url": "https://plain.example.com/mcp"}
}}
EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(jq -c .mcpServers.events .gemini/settings.json)" = '{"url":"https://events.example.com/sse","headers":{"A":"b"}}' ]
	[ "$(jq -c .mcpServers.stream .gemini/settings.json)" = '{"httpUrl":"https://stream.example.com/mcp"}' ]
	[ "$(jq -c .mcpServers.plain .gemini/settings.json)" = '{"httpUrl":"https://plain.example.com/mcp"}' ]
}

@test "link: VS Code keeps an explicit server type, Gemini drops the type of a stdio server" {
	fixture .agents/mcp.json <<'EOF'
{"mcpServers": {
  "fs": {"type": "stdio", "command": "fs-server"},
  "events": {"type": "sse", "url": "https://events.example.com/sse"}
}}
EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(jq -c .servers.fs .vscode/mcp.json)" = '{"type":"stdio","command":"fs-server"}' ]
	[ "$(jq -r .servers.events.type .vscode/mcp.json)" = sse ]
	[ "$(jq -c .mcpServers.fs .gemini/settings.json)" = '{"command":"fs-server"}' ]
}

# --- link mode: idempotence and repair ---

@test "link: a second run prints nothing and changes nothing" {
	link_all
	fixture docs/AGENTS.md <<<"nested rules"
	"$S" >/dev/null
	before=$(state)
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ "$(state)" = "$before" ]
}

@test "link: repairs a symlink with the wrong target" {
	fixture AGENTS.md <<<"root rules"
	fixture OTHER.md <<<"other"
	ln -s OTHER.md CLAUDE.md
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(readlink CLAUDE.md)" = AGENTS.md ]
	has "$output" "linked: ./CLAUDE.md -> AGENTS.md"
	[ "$(cat OTHER.md)" = other ]
}

@test "link: repairs a link to a folder without writing into that folder" {
	mkdir -p .claude wrong
	ln -s ../wrong .claude/skills
	run "$S"
	[ "$status" -eq 0 ]
	[ "$(readlink .claude/skills)" = ../.agents/skills ]
	[ -z "$(ls -A wrong)" ]
}

@test "link: renders a stale file again" {
	link_all
	echo '{"stale": true}' >.gemini/settings.json
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "rendered: .gemini/settings.json" ]
	[ "$(jq -r '.mcpServers | keys | join(",")' .gemini/settings.json)" = "local.tool,plain,remote" ]
}

@test "link: renders all three files again after a change of the MCP source" {
	link_all
	fixture .agents/mcp.json <<<'{"mcpServers": {"only": {"command": "one"}}}'
	run "$S"
	[ "$status" -eq 0 ]
	has "$output" "rendered: .gemini/settings.json"
	has "$output" "rendered: .vscode/mcp.json"
	has "$output" "rendered: .codex/config.toml"
	lacks "$output" "linked:"
	[ "$(jq -c '.servers' .vscode/mcp.json)" = '{"only":{"type":"stdio","command":"one"}}' ]
}

@test "link: replaces a symlink at a rendered path and leaves its target alone" {
	link_all
	rm .vscode/mcp.json
	fixture elsewhere.json <<<"keep me"
	ln -s ../elsewhere.json .vscode/mcp.json
	run "$S"
	[ "$status" -eq 0 ]
	[ ! -L .vscode/mcp.json ]
	[ "$(cat elsewhere.json)" = "keep me" ]
	[ "$(jq -r '.servers | keys | length' .vscode/mcp.json)" = 3 ]
}

# --- link mode: migration ---

@test "link: moves a real CLAUDE.md to AGENTS.md when no AGENTS.md exists" {
	fixture docs/CLAUDE.md <<<"written to the wrong file"
	run "$S"
	[ "$status" -eq 0 ]
	has "$output" "migrated: ./docs/CLAUDE.md -> ./docs/AGENTS.md"
	[ "$(cat docs/AGENTS.md)" = "written to the wrong file" ]
	[ "$(readlink docs/CLAUDE.md)" = AGENTS.md ]
	[ "$(readlink docs/GEMINI.md)" = AGENTS.md ]
}

@test "link: moves a real GEMINI.md to AGENTS.md when no AGENTS.md exists" {
	fixture GEMINI.md <<<"written to the wrong file"
	run "$S"
	[ "$status" -eq 0 ]
	has "$output" "migrated: ./GEMINI.md -> ./AGENTS.md"
	[ "$(cat AGENTS.md)" = "written to the wrong file" ]
	[ "$(readlink GEMINI.md)" = AGENTS.md ]
}

@test "link: migrates one real file and refuses the second, so no text is lost" {
	fixture CLAUDE.md <<<"claude text"
	fixture GEMINI.md <<<"gemini text"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "migrated: ./CLAUDE.md -> ./AGENTS.md"
	has "$output" "error: ./GEMINI.md is a real file; merge it into ./AGENTS.md and delete it"
	[ "$(cat AGENTS.md)" = "claude text" ]
	[ "$(cat GEMINI.md)" = "gemini text" ]
}

# --- link mode: errors ---

@test "link: fails on a real CLAUDE.md beside an AGENTS.md and keeps both files" {
	fixture AGENTS.md <<<"root rules"
	fixture CLAUDE.md <<<"stray rules"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: ./CLAUDE.md is a real file; merge it into ./AGENTS.md and delete it"
	[ "$(cat CLAUDE.md)" = "stray rules" ]
	[ ! -L CLAUDE.md ]
	[ "$(cat AGENTS.md)" = "root rules" ]
}

@test "link: fails on a real GEMINI.md beside an AGENTS.md" {
	fixture docs/AGENTS.md <<<"nested rules"
	fixture docs/GEMINI.md <<<"stray rules"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: ./docs/GEMINI.md is a real file; merge it into ./docs/AGENTS.md and delete it"
	[ "$(cat docs/GEMINI.md)" = "stray rules" ]
}

@test "link: fails when a link path is a real folder, and keeps its content" {
	fixture .claude/skills/mine/SKILL.md <<<"my skill"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .claude/skills is a real file or directory"
	[ -f .claude/skills/mine/SKILL.md ]
}

@test "link: fails when a link path is a real file, and keeps its content" {
	fixture .cursor/mcp.json <<<'{"hand": "written"}'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .cursor/mcp.json is a real file or directory"
	[ "$(cat .cursor/mcp.json)" = '{"hand": "written"}' ]
}

@test "link: fails on .github/copilot-instructions.md, because Copilot reads AGENTS.md" {
	fixture .github/copilot-instructions.md <<<"duplicate rules"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .github/copilot-instructions.md duplicates AGENTS.md for Copilot"
	[ -f .github/copilot-instructions.md ]
	[ ! -e .gemini/settings.json ]
}

@test "link: fails on a broken symlink at .github/copilot-instructions.md" {
	mkdir .github
	ln -s nowhere .github/copilot-instructions.md
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .github/copilot-instructions.md duplicates AGENTS.md for Copilot"
}

@test "link: fails when .mcpServers is not an object, and renders nothing" {
	for json in '{}' '{"mcpServers": []}' '{"mcpServers": "x"}' 'null'; do
		printf '%s\n' "$json" >.agents/mcp.json
		run "$S"
		[ "$status" -eq 1 ]
		has "$output" "error: .agents/mcp.json needs an object at .mcpServers"
	done
	[ ! -e .gemini/settings.json ]
	[ ! -e .vscode/mcp.json ]
	[ ! -e .codex/config.toml ]
	[ ! -e .mcp.json ]
}

@test "link: fails when .agents/mcp.json is not valid JSON" {
	echo '{oops' >.agents/mcp.json
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .agents/mcp.json needs an object at .mcpServers"
	[ ! -e .gemini/settings.json ]
}

@test "link: fails when .agents/mcp.json is missing" {
	rm .agents/mcp.json
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "error: .agents/mcp.json needs an object at .mcpServers"
}

# --- check mode ---

@test "check: prints OK and exits 0 on a correct layout" {
	link_all
	before=$(state)
	run --separate-stderr "$S" --check
	[ "$status" -eq 0 ]
	[ "$output" = "agent layout OK" ]
	[ -z "$stderr" ]
	[ "$(state)" = "$before" ]
}

@test "check: reports every missing link and file on stderr, and changes nothing" {
	fixture AGENTS.md <<<"root rules"
	fixture docs/AGENTS.md <<<"nested rules"
	before=$(state)
	run --separate-stderr "$S" --check
	[ "$status" -eq 1 ]
	[ -z "$output" ]
	for p in ./CLAUDE.md ./GEMINI.md ./docs/CLAUDE.md ./docs/GEMINI.md; do
		has "$stderr" "drift: $p must be a symlink to AGENTS.md"
	done
	has "$stderr" "drift: .claude/skills must be a symlink to ../.agents/skills"
	has "$stderr" "drift: .claude/agents must be a symlink to ../.agents/agents"
	has "$stderr" "drift: .mcp.json must be a symlink to .agents/mcp.json"
	has "$stderr" "drift: .cursor/mcp.json must be a symlink to ../.agents/mcp.json"
	for p in .gemini/settings.json .vscode/mcp.json .codex/config.toml; do
		has "$stderr" "drift: $p is missing or out of date; run: mise run agents:link"
	done
	has "$stderr" "Agent layout drifted. Run: mise run agents:link"
	[ "$(state)" = "$before" ]
}

@test "check: reports a symlink with the wrong target" {
	link_all
	ln -sfn OTHER.md CLAUDE.md
	before=$(state)
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: ./CLAUDE.md must be a symlink to AGENTS.md"
	[ "$(readlink CLAUDE.md)" = OTHER.md ]
	[ "$(state)" = "$before" ]
}

@test "check: reports a real file where a link belongs" {
	link_all
	rm .mcp.json
	cp .agents/mcp.json .mcp.json
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: .mcp.json must be a symlink to .agents/mcp.json"
	[ ! -L .mcp.json ]
}

@test "check: reports a real CLAUDE.md and does not migrate it" {
	link_all
	rm CLAUDE.md
	fixture CLAUDE.md <<<"stray rules"
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: ./CLAUDE.md is a real file; merge it into ./AGENTS.md and delete it"
	[ "$(cat CLAUDE.md)" = "stray rules" ]
}

@test "check: reports a real CLAUDE.md with no AGENTS.md and does not migrate it" {
	fixture docs/CLAUDE.md <<<"stray rules"
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: ./docs/CLAUDE.md is a real file; merge it into ./docs/AGENTS.md and delete it"
	[ ! -e docs/AGENTS.md ]
	[ -f docs/CLAUDE.md ]
	[ ! -L docs/CLAUDE.md ]
}

@test "check: reports a rendered file that was edited by hand" {
	link_all
	echo '{"edited": true}' >.vscode/mcp.json
	before=$(state)
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: .vscode/mcp.json is missing or out of date"
	lacks "$output" ".gemini/settings.json"
	lacks "$output" ".codex/config.toml"
	[ "$(state)" = "$before" ]
}

@test "check: reports all rendered files after a change of the MCP source" {
	link_all
	fixture .agents/mcp.json <<<'{"mcpServers": {"only": {"command": "one"}}}'
	run "$S" --check
	[ "$status" -eq 1 ]
	for p in .gemini/settings.json .vscode/mcp.json .codex/config.toml; do
		has "$output" "drift: $p is missing or out of date"
	done
	lacks "$output" "must be a symlink"
}

@test "check: reports a rendered file that is a symlink, even with the right content" {
	link_all
	cp .codex/config.toml copy.toml
	rm .codex/config.toml
	ln -s ../copy.toml .codex/config.toml
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "drift: .codex/config.toml is missing or out of date"
	[ -L .codex/config.toml ]
}

@test "check: still fails on .github/copilot-instructions.md and on a bad MCP source" {
	link_all
	fixture .github/copilot-instructions.md <<<"duplicate rules"
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "error: .github/copilot-instructions.md duplicates AGENTS.md for Copilot"
	rm .github/copilot-instructions.md
	echo '{}' >.agents/mcp.json
	run "$S" --check
	[ "$status" -eq 1 ]
	has "$output" "error: .agents/mcp.json needs an object at .mcpServers"
}

# --- usage ---

@test "usage: an unknown argument exits 2 with a usage line and changes nothing" {
	fixture AGENTS.md <<<"root rules"
	before=$(state)
	for arg in --fix check; do
		run "$S" "$arg"
		[ "$status" -eq 2 ]
		has "$output" "usage: scripts/agents-link.sh [--check]"
	done
	[ "$(state)" = "$before" ]
}
