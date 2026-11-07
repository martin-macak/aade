#!/usr/bin/env bash
# agentStop hook of the GitHub Copilot cloud agent (.github/hooks/agents-check.json).
#
# Pre-commit does not run on the commits of the cloud agent, so this hook is
# its quality gate. It runs `mise run check`. On a failure it prints
# {"decision":"block","reason":...}, and Copilot gives the agent another turn
# with the reason as its prompt. Exit 0 with no output lets the agent stop.
# The hook always exits 0, because Copilot ignores the output of a failed hook.
#
# When mise is missing, the hook lets the agent stop and warns on stderr.
# The ci workflow stays the backstop.
set -uo pipefail

# Blocks in a row before the hook gives up. Copilot itself ends the turn
# after 8, and each extra turn counts against the 59-minute job limit.
MAX_BLOCKS=3
COUNTER="${TMPDIR:-/tmp}/aade-copilot-stop-blocks"

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 0

# Copilot sends the event as JSON on stdin. stop_hook_active is true when a
# block of this hook forced the current turn.
input=$(cat || true)
if [[ "$input" =~ \"stop_hook_active\"[[:space:]]*:[[:space:]]*true ]]; then
	blocks=$(cat "$COUNTER" 2>/dev/null || echo 0)
else
	blocks=0
fi

# The docs do not say whether hooks inherit PATH from the setup steps.
# jdx/mise-action installs mise below these folders.
PATH="$HOME/.local/bin:$HOME/.local/share/mise/bin:$HOME/.local/share/mise/shims:$PATH"
if ! command -v mise >/dev/null 2>&1; then
	>&2 echo "copilot-stop-check: mise is not installed; skipping mise run check."
	exit 0
fi

# jdx/mise-action trusts mise.toml only for the path of the setup checkout.
# The agent may work in another clone, so trust this one for this run only.
export MISE_TRUSTED_CONFIG_PATHS="$PWD" MISE_YES=1
# Git ignores the downloaded Vale packages, so another clone lacks them.
[ -d .vale/styles/ai-tells ] || mise exec -- vale sync >/dev/null 2>&1

if output=$(mise run check 2>&1); then
	rm -f "$COUNTER"
	exit 0
fi

if ((blocks >= MAX_BLOCKS)); then
	>&2 echo "copilot-stop-check: mise run check still fails after $MAX_BLOCKS turns; letting the agent stop."
	rm -f "$COUNTER"
	exit 0
fi
echo $((blocks + 1)) >"$COUNTER"

reason="The quality gate failed: \`mise run check\` exited non-zero. Fix every problem below. Do not disable or weaken a check.

$(tail -n 80 <<<"$output")"
# When jq cannot run, block with a fixed reason. A failed hook would let
# the agent stop.
mise exec -- jq -cn --arg reason "$reason" '{decision: "block", reason: $reason}' 2>/dev/null ||
	echo '{"decision":"block","reason":"The quality gate failed: `mise run check` exited non-zero. Run it, and fix every problem that it prints. Do not disable or weaken a check."}'
exit 0
