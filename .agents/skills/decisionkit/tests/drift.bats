#!/usr/bin/env bats

# Drift tests for the decisionkit skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here. decisionkit is not
# in CI, so each test that runs it skips when it is missing.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	SKILL="$ROOT/.agents/skills/decisionkit/SKILL.md"
	FACADE="$ROOT/.agents/skills/decisionkit/scripts/decide.sh"
	HEALTH="$ROOT/scripts/agents-health.sh"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

# Skip the test when the decisionkit CLI is not installed. Otherwise store
# its help text in HELP. Call it directly, not in a subshell, so that skip
# ends the test.
need_decisionkit() {
	command -v decisionkit >/dev/null 2>&1 || skip "decisionkit is not installed"
	HELP=$(decisionkit --help </dev/null 2>&1)
}

# Print the lines of the first "sh" code block of SKILL.md.
commands_block() {
	awk '/^```sh$/ { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL"
}

# Print the body of one function of the agent health check.
health_body() {
	awk -v head="$1() {" '$0 == head { inside = 1; next } inside && /^}/ { exit } inside' "$HEALTH"
}

# Print the lines of the "## <name>" section of SKILL.md.
section() {
	awk -v head="## $1" '$0 == head { inside = 1; next } inside && /^## / { exit } inside' "$SKILL"
}

# Print the value of the variable $1 in the block "sh facade" of SKILL.md.
facade_value() {
	awk '$0 == "```sh facade" { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL" |
		sed -n "s/^$1=//p"
}

@test "mise.toml pins decisionkit to an exact version" {
	grep -qE '^"npm:@adxtya21/decisionkit" = \{ version = "[0-9]+\.[0-9]+\.[0-9]+"' "$ROOT/mise.toml"
}

@test "the commands in the skill are the commands of decisionkit" {
	need_decisionkit
	listed=$(commands_block | sed -nE 's/^decisionkit +([a-z]+) .*/\1/p' | sort)
	[ "$listed" = "$(printf 'binary\nchoice\nrank\nscore')" ]
	for cmd in $listed status; do
		grep -qE "^ +decisionkit $cmd( |\$)" <<<"$HELP" || {
			echo "decisionkit --help lists no command $cmd."
			return 1
		}
	done
	# The skill sends the user to this command when decisionkit fails.
	[[ "$TEXT" == *'run `decisionkit status`'* ]]
}

@test "the options in the skill exist in decisionkit" {
	need_decisionkit
	options=$(grep -oE -- '--[a-z]+' <<<"$TEXT" | sort -u)
	[ "$(wc -l <<<"$options")" -ge 5 ]
	for option in --json --quiet --plain --threshold --context; do
		grep -qx -- "$option" <<<"$options" || {
			echo "SKILL.md no longer names $option."
			return 1
		}
	done
	for option in $options; do
		grep -qF -- "$option" <<<"$HELP" || {
			echo "SKILL.md names $option, but decisionkit --help does not list it."
			return 1
		}
	done
}

@test "the result forms in the skill match decisionkit" {
	need_decisionkit
	for form in 'true|false <p_true>' '<choice> <p>' '(expected <n>)'; do
		commands_block | grep -qF -- "$form" || {
			echo "The command block of SKILL.md does not show: $form"
			return 1
		}
		grep -qF -- "$form" <<<"$HELP" || {
			echo "decisionkit --help does not show: $form"
			return 1
		}
	done
}

@test "the exit codes in the skill match decisionkit" {
	need_decisionkit
	grep -qF 'Exit codes: 0 = true / confident, 1 = false / below threshold, 2 = error.' <<<"$HELP"
	[[ "$TEXT" == *'`0` means true or confident, `1` means false or below `--threshold`, and `2` means an error.'* ]]
}

@test "decisionkit reads the provider variable that the skill names" {
	need_decisionkit
	grep -qF 'DECISIONKIT_PROVIDER' <<<"$HELP"
	[[ "$TEXT" == *'in `DECISIONKIT_PROVIDER`'* ]]
}

@test "mise run agents:health runs the decisionkit checks" {
	[ "$(yq -p toml '.tasks["agents:health"].run' "$ROOT/mise.toml")" = scripts/agents-health.sh ]
	[[ "$TEXT" == *'`mise run agents:health` also checks decisionkit.'* ]]
	checks=$(awk '/^CHECKS=\(/ { inside = 1; next } inside && /^\)/ { exit } inside { gsub(/[ \t]/, ""); print }' "$HEALTH")
	for check in check_decisionkit_installed check_decisionkit_provider check_decisionkit_status; do
		grep -qx "$check" <<<"$checks" || {
			echo "The CHECKS array of agents-health.sh does not list $check."
			return 1
		}
		[ -n "$(health_body "$check")" ] || {
			echo "agents-health.sh does not define $check."
			return 1
		}
	done
	health_body check_decisionkit_installed | grep -qF 'command -v decisionkit'
	health_body check_decisionkit_provider | grep -qF 'DECISIONKIT_PROVIDER'
	health_body check_decisionkit_status | grep -qF 'decisionkit status'
}

@test "the provider is set in mise.local.toml, which Git ignores" {
	git -C "$ROOT" check-ignore -q mise.local.toml
	grep -qF 'DECISIONKIT_PROVIDER' "$ROOT/README.md"
	grep -qF 'mise.local.toml' "$ROOT/README.md"
	health_body check_decisionkit_provider | grep -qF 'Set it in mise.local.toml'
	[[ "$TEXT" == *'Each contributor sets it in the `[env]` table of `mise.local.toml`, which Git ignores.'* ]]
}

@test "AGENTS.md sends agents to this skill for closed decisions" {
	agents=$(tr '\n' ' ' <"$ROOT/AGENTS.md" | tr -s ' ')
	[[ "$agents" == *'Load the `decisionkit` skill first.'* ]]
	[ "$(sed -n 's/^name: //p' "$SKILL")" = decisionkit ]
}

@test "the facade block sets the limits that the prose and the script use" {
	min=$(facade_value UNCERTAIN_MIN)
	tie=$(facade_value RANK_TIE)
	[ -n "$min" ]
	[ -n "$tie" ]
	[[ "$TEXT" == *"**Below $min is uncertain.**"* ]]
	for name in UNCERTAIN_MIN RANK_TIE; do
		grep -qF "\$$name" "$FACADE" || {
			echo "decide.sh does not use $name."
			return 1
		}
	done
	grep -qF '```sh facade' "$FACADE"
}

@test "the facade commands in the skill are the commands of the script" {
	listed=$(section Facade | sed -nE 's/^scripts\/decide\.sh ([a-z]+) .*/\1/p' | sort)
	[ "$listed" = "$(printf 'ask\ncalibrate')" ]
	[ -x "$FACADE" ]
	for cmd in $listed; do
		grep -qE "^$cmd\)$" "$FACADE" || {
			echo "decide.sh has no command $cmd."
			return 1
		}
	done
}

@test "the facade calls decisionkit only with options that decisionkit has" {
	need_decisionkit
	# The lines that build the arguments of decisionkit, and its calls. jq
	# has options of its own.
	options=$(grep -E 'args=\(|decisionkit "\$\{args' "$FACADE" | grep -oE -- '--[a-z]+' | sort -u)
	[ "$(wc -l <<<"$options")" -ge 4 ]
	for option in $options; do
		grep -qF -- "$option" <<<"$HELP" || {
			echo "decide.sh uses $option, but decisionkit --help does not list it."
			return 1
		}
	done
}
