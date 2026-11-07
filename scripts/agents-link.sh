#!/usr/bin/env bash
# Keeps the agent-agnostic layout consistent.
#
#   scripts/agents-link.sh          create or repair links and generated files
#   scripts/agents-link.sh --check  report drift and exit 1; change nothing
#
# Source of truth:
#   AGENTS.md (any directory)  -> CLAUDE.md, GEMINI.md symlinks beside it
#   .agents/skills, .agents/agents -> symlinked into .claude/
#   .agents/mcp.json           -> symlinked or rendered into each tool's MCP config
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

DRIFT=0
MCP_SRC=".agents/mcp.json"

say()  { printf '%s\n' "$*"; }
fail() { printf 'drift: %s\n' "$*" >&2; DRIFT=1; }

# ensure_link <path> <relative-target>
ensure_link() {
  local path="$1" target="$2"
  if [ -L "$path" ] && [ "$(readlink "$path")" = "$target" ]; then
    return 0
  fi
  if [ "$CHECK" = 1 ]; then
    fail "$path must be a symlink to $target"
    return 0
  fi
  if [ -e "$path" ] && [ ! -L "$path" ]; then
    echo "error: $path is a real file or directory; move its content to the source of truth, then delete it" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$path")"
  ln -sfn "$target" "$path"
  say "linked: $path -> $target"
}

# ensure_file <path> <content>
ensure_file() {
  local path="$1" content="$2"
  if [ -f "$path" ] && [ ! -L "$path" ] && [ "$(cat "$path")" = "$content" ]; then
    return 0
  fi
  if [ "$CHECK" = 1 ]; then
    fail "$path is missing or out of date; run: mise run agents:link"
    return 0
  fi
  mkdir -p "$(dirname "$path")"
  rm -f "$path"
  printf '%s\n' "$content" > "$path"
  say "rendered: $path"
}

# 1. Context files: every AGENTS.md gets CLAUDE.md and GEMINI.md symlinks.
PRUNE=( \( -name .git -o -name node_modules -o -name .direnv -o -name .venv \) -prune -o )

# A real CLAUDE.md or GEMINI.md means an agent wrote to the wrong file.
while read -r f; do
  d="$(dirname "$f")"
  if [ "$CHECK" = 0 ] && [ ! -e "$d/AGENTS.md" ]; then
    mv "$f" "$d/AGENTS.md"
    say "migrated: $f -> $d/AGENTS.md"
  elif [ "$CHECK" = 1 ]; then
    fail "$f is a real file; merge it into $d/AGENTS.md and delete it"
  else
    echo "error: $f is a real file; merge it into $d/AGENTS.md and delete it" >&2
    exit 1
  fi
done < <(find . "${PRUNE[@]}" \( -name CLAUDE.md -o -name GEMINI.md \) -type f -print | sort)

while read -r agents; do
  d="$(dirname "$agents")"
  ensure_link "$d/CLAUDE.md" AGENTS.md
  ensure_link "$d/GEMINI.md" AGENTS.md
done < <(find . "${PRUNE[@]}" -name AGENTS.md -type f -print | sort)

# 2. Shared skills and subagents.
ensure_link .claude/skills ../.agents/skills
ensure_link .claude/agents ../.agents/agents

# Copilot reads AGENTS.md natively. This file would load the rules twice.
if [ -e .github/copilot-instructions.md ] || [ -L .github/copilot-instructions.md ]; then
  echo "error: .github/copilot-instructions.md duplicates AGENTS.md for Copilot; move any unique rule to AGENTS.md, then delete it" >&2
  exit 1
fi

# 3. MCP servers: one source, five consumers.
jq -e '.mcpServers | type == "object"' "$MCP_SRC" >/dev/null \
  || { echo "error: $MCP_SRC needs an object at .mcpServers" >&2; exit 1; }

ensure_link .mcp.json "$MCP_SRC"                 # Claude Code (same schema)
ensure_link .cursor/mcp.json "../$MCP_SRC"       # Cursor (same schema)

# Gemini CLI: an SSE server uses url, every other remote server httpUrl
# (streamable HTTP).
ensure_file .gemini/settings.json "$(jq '{mcpServers: (.mcpServers | map_values(
  if .url then (if .type == "sse" then {url: .url} else {httpUrl: .url} end)
    + (if .headers then {headers: .headers} else {} end)
  else del(.type) end))}' "$MCP_SRC")"

# VS Code / GitHub Copilot: top-level key is "servers" and type is required.
ensure_file .vscode/mcp.json "$(jq '{servers: (.mcpServers | map_values(
  if .url then {type: (.type // "http"), url: .url} + (if .headers then {headers: .headers} else {} end)
  else {type: "stdio"} + del(.type) end))}' "$MCP_SRC")"

# Codex: TOML tables. JSON string escapes are valid TOML basic strings.
ensure_file .codex/config.toml "$(jq -r '
  "# Generated from .agents/mcp.json by scripts/agents-link.sh. Do not edit.",
  (.mcpServers | to_entries[] |
    "",
    "[mcp_servers.\(.key | tojson)]",
    (.value |
      (if .command then "command = \(.command | tojson)" else empty end),
      (if .args then "args = \(.args | tojson)" else empty end),
      (if .url then "url = \(.url | tojson)" else empty end),
      (if .headers then "http_headers = { \(.headers | to_entries | map("\(.key | tojson) = \(.value | tojson)") | join(", ")) }" else empty end),
      (if .env then "env = { \(.env | to_entries | map("\(.key | tojson) = \(.value | tojson)") | join(", ")) }" else empty end)
    ))' "$MCP_SRC")"

if [ "$DRIFT" = 1 ]; then
  echo "Agent layout drifted. Run: mise run agents:link" >&2
  exit 1
fi
[ "$CHECK" = 1 ] && say "agent layout OK"
exit 0
