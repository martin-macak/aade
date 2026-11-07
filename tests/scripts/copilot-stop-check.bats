#!/usr/bin/env bats

# scripts/copilot-stop-check.sh is the quality gate of the GitHub Copilot
# cloud agent, because pre-commit does not run on its commits. The agentStop
# hook runs `mise run check`. On a failure it blocks the stop with the output
# as the reason, so the agent gets another turn. It gives up after a few
# blocks in a row, and it never fails itself. A fake mise stands in for the
# real one at $HOME/.local/bin, the first folder that the hook adds to PATH,
# so no test runs the real checks.

bats_require_minimum_version 1.5.0

load helpers/common

# Run the hook with the event $1 on stdin. $output holds stdout, $stderr
# holds stderr.
hook() {
	run --separate-stderr "$HOOK" <<<"$1"
}

# Run the hook with a PATH that holds only the basic tools that it needs,
# so no mise of this machine can leak in. The event $1 goes to stdin.
hook_lean() {
	local bin=$BATS_TEST_TMPDIR/lean tool
	mkdir -p "$bin"
	for tool in dirname cat rm tail; do
		ln -sf "$(command -v "$tool")" "$bin/$tool"
	done
	ln -sf "$BASH" "$bin/bash"
	run --separate-stderr env PATH="$bin" "$BASH" "$HOOK" <<<"${1-}"
}

setup() {
	sandbox copilot-stop-check.sh
	HOOK=$SANDBOX/scripts/copilot-stop-check.sh
	COUNTER=$TMPDIR/aade-copilot-stop-blocks
	MAX_BLOCKS=$(sed -n 's/^MAX_BLOCKS=//p' "$HOOK")
	TAIL_LINES=$(sed -n 's/.*tail -n \([0-9][0-9]*\).*/\1/p' "$HOOK")
	unset MISE_TRUSTED_CONFIG_PATHS MISE_YES MISE_RUN_OUTPUT MISE_RUN_ERROR MISE_RUN_STATUS VALE_STATUS
	# The hook skips the Vale download when the styles are there. Else it
	# runs `vale sync`, which prints noise and exits with $VALE_STATUS.
	mkdir -p .vale/styles/ai-tells
	fake vale 'echo "vale: noise"; echo "vale: noise on stderr" >&2; exit "${VALE_STATUS:-0}"'
}

@test "the block limit and the output tail are positive numbers" {
	[ "$MAX_BLOCKS" -gt 0 ]
	[ "$TAIL_LINES" -gt 0 ]
}

# --- Mise ---

@test "mise missing: lets the agent stop, warns on stderr, prints nothing on stdout" {
	hook_lean '{"stop_hook_active": false}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	has "$stderr" "copilot-stop-check: mise is not installed; skipping mise run check."
}

@test "mise missing: keeps the block count as it is" {
	echo 2 >"$COUNTER"
	hook_lean '{"stop_hook_active": true}'
	[ "$status" -eq 0 ]
	[ "$(cat "$COUNTER")" = 2 ]
}

@test "finds mise in each folder where jdx/mise-action installs it" {
	local dir
	for dir in .local/bin .local/share/mise/bin .local/share/mise/shims; do
		rm -rf "$HOME/.local"
		fake_mise "$HOME/$dir"
		rm -f "$FAKE_LOG"
		hook_lean '{}'
		[ "$status" -eq 0 ]
		[ -z "$stderr" ]
		has "$(calls)" "mise run check"
	done
}

@test "prefers the mise below HOME over another mise on PATH" {
	fake_mise "$HOME/.local/bin"
	fake mise 'echo called >"$FAKE_DIR/decoy"; exit 7'
	hook '{}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -f "$FAKE_DIR/mise.run" ]
	[ ! -e "$FAKE_DIR/decoy" ]
}

@test "runs the check in the repository root, whatever the current folder" {
	fake_mise "$HOME/.local/bin"
	cd "$BATS_TEST_TMPDIR"
	hook '{}'
	[ "$status" -eq 0 ]
	has "$(cat "$FAKE_DIR/mise.run")" "cwd=$SANDBOX "
}

@test "trusts the mise config of this checkout and answers yes to prompts" {
	fake_mise "$HOME/.local/bin"
	hook '{}'
	[ "$status" -eq 0 ]
	has "$(cat "$FAKE_DIR/mise.run")" "cwd=$SANDBOX trusted=$SANDBOX yes=1"
}

# --- Vale styles ---

@test "vale: downloads the styles before the check when they are missing" {
	fake_mise "$HOME/.local/bin"
	rmdir .vale/styles/ai-tells
	hook '{}'
	[ "$status" -eq 0 ]
	[ "$(calls | head -n 1)" = "mise exec -- vale sync" ]
	has "$(calls)" "mise run check"
}

@test "vale: does not download the styles when they are there" {
	fake_mise "$HOME/.local/bin"
	hook '{}'
	[ "$status" -eq 0 ]
	lacks "$(calls)" "vale sync"
}

@test "vale: keeps its output away from the hook output" {
	fake_mise "$HOME/.local/bin"
	rmdir .vale/styles/ai-tells
	hook '{}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$stderr" ]
}

@test "vale: runs the check even when the download fails" {
	fake_mise "$HOME/.local/bin"
	rmdir .vale/styles/ai-tells
	export VALE_STATUS=1
	hook '{}'
	[ "$status" -eq 0 ]
	has "$(calls)" "mise run check"
}

# --- The check passes ---

@test "check passes: lets the agent stop and prints nothing" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_OUTPUT="all good"
	hook '{"stop_hook_active": false}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$stderr" ]
}

@test "check passes: removes the block counter" {
	fake_mise "$HOME/.local/bin"
	echo 2 >"$COUNTER"
	hook '{"stop_hook_active": true}'
	[ "$status" -eq 0 ]
	[ ! -e "$COUNTER" ]
}

# --- The check fails ---

@test "check fails: exits 0 and prints a block decision as one line of JSON" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1 MISE_RUN_OUTPUT=$'lint: bad link in a.md\nvale: 1 error'
	hook '{"stop_hook_active": false}'
	[ "$status" -eq 0 ]
	[ -z "$stderr" ]
	[ "$(printf '%s\n' "$output" | wc -l | tr -d ' ')" -eq 1 ]
	jq -e '.decision == "block"' <<<"$output"
}

@test "check fails: the reason tells the agent to fix and holds the whole output" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1 MISE_RUN_OUTPUT=$'lint: bad link in a.md\nvale: 1 error' MISE_RUN_ERROR="mise: task failed"
	hook '{}'
	reason=$(jq -r .reason <<<"$output")
	has "$reason" "The quality gate failed"
	has "$reason" "Do not disable or weaken a check."
	has "$reason" "lint: bad link in a.md"
	has "$reason" "vale: 1 error"
	has "$reason" "mise: task failed"
}

@test "check fails: keeps only the last lines of a long output" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1 MISE_RUN_OUTPUT
	MISE_RUN_OUTPUT=$(seq 1 $((TAIL_LINES + 20)))
	hook '{}'
	[ "$status" -eq 0 ]
	reason=$(jq -r .reason <<<"$output")
	kept=$(grep -E '^[0-9]+$' <<<"$reason")
	[ "$(grep -c '' <<<"$kept")" -eq "$TAIL_LINES" ]
	[ "$(head -n 1 <<<"$kept")" -eq 21 ]
	[ "$(tail -n 1 <<<"$kept")" -eq $((TAIL_LINES + 20)) ]
}

@test "check fails: keeps the JSON valid for quotes, backslashes and backticks" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1 MISE_RUN_OUTPUT='say "hi" in C:\dir with `tick`'
	hook '{}'
	[ "$status" -eq 0 ]
	reason=$(jq -r .reason <<<"$output")
	has "$reason" 'say "hi" in C:\dir with `tick`'
}

# --- Block counter ---

@test "counter: the first block writes 1" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	hook '{"stop_hook_active": false}'
	[ "$status" -eq 0 ]
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 1 ]
}

@test "counter: stop_hook_active true adds one to the count" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo 1 >"$COUNTER"
	hook '{"stop_hook_active": true}'
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 2 ]
}

@test "counter: stop_hook_active true without a counter file counts from zero" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	hook '{"stop_hook_active": true}'
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 1 ]
}

@test "counter: reads stop_hook_active with spaces around the colon" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo 1 >"$COUNTER"
	hook '{"stop_hook_active"  :  true, "cwd": "/x"}'
	[ "$(cat "$COUNTER")" = 2 ]
}

@test "counter: stop_hook_active false starts the count again" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo $((MAX_BLOCKS - 1)) >"$COUNTER"
	hook '{"stop_hook_active": false}'
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 1 ]
}

@test "counter: an event without stop_hook_active starts the count again" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo $((MAX_BLOCKS - 1)) >"$COUNTER"
	hook '{"cwd": "/x"}'
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 1 ]
}

@test "counter: empty stdin counts as a first stop" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo $((MAX_BLOCKS - 1)) >"$COUNTER"
	run --separate-stderr "$HOOK" </dev/null
	[ "$status" -eq 0 ]
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = 1 ]
}

@test "counter: empty stdin with a passing check lets the agent stop" {
	fake_mise "$HOME/.local/bin"
	run --separate-stderr "$HOOK" </dev/null
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "counter: still blocks one turn before the limit" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo $((MAX_BLOCKS - 1)) >"$COUNTER"
	hook '{"stop_hook_active": true}'
	[ "$status" -eq 0 ]
	has "$output" '"decision":"block"'
	[ "$(cat "$COUNTER")" = "$MAX_BLOCKS" ]
}

@test "counter: at the limit lets the agent stop, warns on stderr and removes the counter" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	echo "$MAX_BLOCKS" >"$COUNTER"
	hook '{"stop_hook_active": true}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	has "$stderr" "copilot-stop-check: mise run check still fails after $MAX_BLOCKS turns; letting the agent stop."
	[ ! -e "$COUNTER" ]
}

@test "counter: a failing check blocks the stop MAX_BLOCKS times in a row, then lets it go" {
	fake_mise "$HOME/.local/bin"
	export MISE_RUN_STATUS=1
	local turn active=false
	for turn in $(seq 1 "$MAX_BLOCKS"); do
		hook "{\"stop_hook_active\": $active}"
		has "$output" '"decision":"block"'
		active=true
	done
	hook '{"stop_hook_active": true}'
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	has "$stderr" "still fails after"
	[ ! -e "$COUNTER" ]
}
