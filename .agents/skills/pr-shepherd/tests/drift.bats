#!/usr/bin/env bats

# Drift tests for the pr-shepherd skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here, and no test calls
# GitHub.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	DIR="$ROOT/.agents/skills/pr-shepherd"
	SKILL="$DIR/SKILL.md"
	SCRIPT="$DIR/scripts/shepherd.sh"
	QUESTIONS="$DIR/references/questions.yml"
	CALIBRATION="$DIR/tests/fixtures/calibration"
	TEMPLATE="$ROOT/.github/pull_request_template.md"
	WORKFLOW="$ROOT/.github/workflows/pr-shepherd.yml"
	LABELS="$ROOT/.github/labels.yml"
	MISE="$ROOT/mise.toml"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

# Print the lines of the "## <name>" section of SKILL.md.
section() {
	awk -v head="## $1" '$0 == head { inside = 1; next } inside && /^## / { exit } inside' "$SKILL"
}

@test "the folder, the front matter name and the Claude Code path agree" {
	dir=$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)
	[ "$(yq --front-matter=extract '.name' "$SKILL")" = "$(basename "$dir")" ]
	[ "$(cd "$ROOT/.claude/skills/$(basename "$dir")" && pwd -P)" = "$dir" ]
}

@test "the Script section lists the usage of the script, line for line" {
	listed=$(section Script | sed -n 's/^shepherd\.sh /shepherd.sh /p')
	usage=$(sed -nE 's/^# (Usage: |       )shepherd\.sh/shepherd.sh/p' "$SCRIPT")
	diff <(echo "$listed") <(echo "$usage")
}

@test "every command that the skill runs exists in the script" {
	for cmd in $(grep -oE '\$P [a-z]+' "$SKILL" | awk '{ print $2 }' | sort -u); do
		grep -qE "^$cmd\) cmd_$cmd " "$SCRIPT" || {
			echo "SKILL.md runs \$P $cmd, but shepherd.sh has no such command."
			return 1
		}
	done
}

@test "the questions in the skill match questions.yml, and each has fixtures" {
	names=$(yq '.questions[].name' "$QUESTIONS")
	[ "$(echo $names)" = "carryover evidence finding-valid finding-severity" ]
	for name in $names; do
		[[ "$TEXT" == *"\`$name\`"* ]] || {
			echo "SKILL.md does not name the question $name."
			return 1
		}
		grep -qE "(ask|\"\\\$QUESTIONS\") $name( |\$)" "$SCRIPT" || {
			echo "shepherd.sh never asks the question $name."
			return 1
		}
		kind=$(NAME=$name yq '.questions[] | select(.name == strenv(NAME)) | .kind' "$QUESTIONS")
		labels="true false"
		[[ "$kind" == score ]] && labels=$(NAME=$name yq '.questions[] | select(.name == strenv(NAME)) | .options[]' "$QUESTIONS")
		for label in $labels; do
			count=$(find "$CALIBRATION/$name" -name "$label-*.txt" | wc -l)
			((count >= 3)) || {
				echo "$name has $count fixtures for $label. It needs at least 3."
				return 1
			}
		done
	done
}

@test "the script names the trace status, the marker, the label and the check of the skill" {
	for pair in CONTEXT:pr-shepherd/trace "MARKER:<!-- pr-shepherd-trace:v1 -->" NO_ISSUE_LABEL:pr:no-issue CHECK_NAME:pr-shepherd WORKFLOW:pr-shepherd.yml; do
		name=${pair%%:*}
		value=${pair#*:}
		grep -qxF "$name=$value" "$SCRIPT" || grep -qxF "$name='$value'" "$SCRIPT" || {
			echo "shepherd.sh does not set $name=$value."
			return 1
		}
		[[ "$name" == WORKFLOW ]] && continue
		[[ "$TEXT" == *"\`$value\`"* ]] || {
			echo "SKILL.md does not name $value."
			return 1
		}
	done
}

@test "the label pr:no-issue exists in labels.yml" {
	yq -e '.[] | select(.name == "pr:no-issue")' "$LABELS" >/dev/null
}

@test "the PR template has the sections and the formats of the skill" {
	grep -qx '## Requirements' "$TEMPLATE"
	grep -qx '## Verify' "$TEMPLATE"
	grep -qx 'Closes #' "$TEMPLATE"
	grep -qx -- '- \[ \] R1:' "$TEMPLATE"
	grep -qx -- '- \[ \] V1 (R1):' "$TEMPLATE"
	grep -qF 'shepherd.sh' "$TEMPLATE"
	grep -qF 'pr:no-issue' "$TEMPLATE"
}

@test "the workflow job pr-shepherd runs the check on each PR event" {
	[ "$(yq '.jobs["pr-shepherd"].steps[-1].run' "$WORKFLOW")" = 'mise run pr:check "$PR"' ]
	for event in pull_request pull_request_review pull_request_review_comment issues; do
		yq -e ".on | has(\"$event\")" "$WORKFLOW" >/dev/null
	done
	[ "$(yq '.jobs.disarm.steps[-1].run' "$WORKFLOW")" = 'mise run pr:shepherd disarm "$ISSUE"' ]
	# The job may only read. A write would let a PR change its own trace.
	[ -z "$(yq '.jobs["pr-shepherd"].permissions | to_entries | .[] | select(.value != "read") | .key' "$WORKFLOW")" ]
	[[ "$TEXT" == *'The `pr-shepherd` workflow runs `mise run pr:check`'* ]]
}

@test "the mise tasks run the script, and check does not depend on them" {
	[ "$(yq -p toml '.tasks["pr:check"].run' "$MISE")" = ".agents/skills/pr-shepherd/scripts/shepherd.sh check" ]
	[ "$(yq -p toml '.tasks["pr:shepherd"].run' "$MISE")" = ".agents/skills/pr-shepherd/scripts/shepherd.sh" ]
	! yq -p toml '.tasks.check.depends[]' "$MISE" | grep -q '^pr:'
	[[ "$TEXT" == *'mise run pr:check <pr>'* && "$TEXT" == *'mise run pr:shepherd'* ]]
}

@test "the Makefile calibrates with the decisionkit facade" {
	grep -qF '../decisionkit/scripts/decide.sh calibrate references/questions.yml tests/fixtures/calibration' "$DIR/Makefile"
	[[ "$TEXT" == *'make -C .agents/skills/pr-shepherd calibrate'* ]]
}
