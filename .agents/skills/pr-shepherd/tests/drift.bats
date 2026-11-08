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
	LEFTOVERS_WORKFLOW="$ROOT/.github/workflows/leftovers.yml"
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
	[ "$(echo $names)" = "carryover evidence finding-valid finding-severity followup" ]
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
	[[ "$TEXT" == *'The `pr-shepherd` workflow runs `mise run pr:check`'* ]] || false
}

@test "the workflow job carry copies the trace on a push, with the code of the base" {
	[ "$(yq '.jobs.carry.steps[-1].run' "$WORKFLOW")" = 'mise run pr:shepherd carry "$PR" "$BEFORE" "$AFTER"' ]
	[ "$(yq '.jobs.carry.steps[-1].env.BEFORE' "$WORKFLOW")" = '${{ github.event.before }}' ]
	[ "$(yq '.jobs.carry.steps[-1].env.AFTER' "$WORKFLOW")" = '${{ github.event.after }}' ]
	yq -e '.on.pull_request.types[] | select(. == "synchronize")' "$WORKFLOW" >/dev/null
	cond=$(yq '.jobs.carry.if' "$WORKFLOW")
	[[ "$cond" == *"github.event.action == 'synchronize'"* ]] || false
	# A fork PR gets a read-only token.
	[[ "$cond" == *"github.event.pull_request.head.repo.full_name == github.repository"* ]] || false
	# The job may write statuses, so it must not run the code of the PR.
	[ "$(yq '.jobs.carry.steps[0].with.ref' "$WORKFLOW")" = '${{ github.event.pull_request.base.sha }}' ]
	[ "$(yq '.jobs.carry.permissions.statuses' "$WORKFLOW")" = write ]
	[ "$(yq '[.jobs[] | select(.permissions.statuses == "write")] | length' "$WORKFLOW")" -eq 1 ]
	# The check reads the carried trace in the same run, also when carry
	# is skipped or fails.
	[ "$(yq '.jobs["pr-shepherd"].needs' "$WORKFLOW")" = carry ]
	[[ "$(yq '.jobs["pr-shepherd"].if' "$WORKFLOW")" == *'!cancelled()'* ]] || false
	[[ "$TEXT" == *'The `carry` job of the `pr-shepherd` workflow'* ]] || false
}

@test "the mise tasks run the script, and check does not depend on them" {
	[ "$(yq -p toml '.tasks["pr:check"].run' "$MISE")" = ".agents/skills/pr-shepherd/scripts/shepherd.sh check" ]
	[ "$(yq -p toml '.tasks["pr:shepherd"].run' "$MISE")" = ".agents/skills/pr-shepherd/scripts/shepherd.sh" ]
	! yq -p toml '.tasks.check.depends[]' "$MISE" | grep -q '^pr:' || false
	[[ "$TEXT" == *'mise run pr:check <pr>'* && "$TEXT" == *'mise run pr:shepherd'* ]] || false
}

@test "the Makefile calibrates with the decisionkit facade" {
	grep -qF '../decisionkit/scripts/decide.sh calibrate references/questions.yml tests/fixtures/calibration' "$DIR/Makefile"
	[[ "$TEXT" == *'make -C .agents/skills/pr-shepherd calibrate'* ]] || false
}

@test "the leftover label of the script exists in labels.yml, and the skill names it" {
	grep -qxF 'LEFTOVER_LABEL=origin:leftover' "$SCRIPT"
	grep -qxF 'LEFTOVER_QUERY=origin%3Aleftover' "$SCRIPT"
	yq -e '.[] | select(.name == "origin:leftover")' "$LABELS" >/dev/null
	[[ "$TEXT" == *'`origin:leftover`'* ]] || false
}

@test "the PR template has the Leftovers section with the item format of the skill" {
	grep -qx '## Leftovers' "$TEMPLATE"
	grep -qx -- '- \[ \] chore(tooling): Pin the Vale package version' "$TEMPLATE"
	grep -qF '^## Leftovers[ \t]*$' "$SCRIPT"
	[[ "$TEXT" == *'`- [ ] <type>(<scope>): <title>`'* ]] || false
	# The example of the skill uses the item of the template.
	section Leftovers | grep -qx -- '- \[ \] chore(tooling): Pin the Vale package version'
}

@test "the leftovers workflow runs the leftovers command after a merge, on the merge commit" {
	yq -e '.on.pull_request_target.types[] | select(. == "closed")' "$LEFTOVERS_WORKFLOW" >/dev/null
	[ "$(yq '.on | keys | length' "$LEFTOVERS_WORKFLOW")" -eq 1 ]
	[ "$(yq '.jobs.file.if' "$LEFTOVERS_WORKFLOW")" = 'github.event.pull_request.merged == true' ]
	[ "$(yq '.jobs.file.steps[0].with.ref' "$LEFTOVERS_WORKFLOW")" = '${{ github.event.pull_request.merge_commit_sha }}' ]
	[ "$(yq '.jobs.file.steps[0].with.persist-credentials' "$LEFTOVERS_WORKFLOW")" = false ]
	[ "$(yq '.jobs.file.steps[-1].run' "$LEFTOVERS_WORKFLOW")" = 'mise run pr:shepherd leftovers "$PR"' ]
	[ "$(yq '.jobs.file.permissions.issues' "$LEFTOVERS_WORKFLOW")" = write ]
	# Only the issues permission writes. The body never enters an expression.
	[ "$(yq '[.jobs.file.permissions | to_entries | .[] | select(.value == "write")] | length' "$LEFTOVERS_WORKFLOW")" -eq 1 ]
	! grep -qF 'pull_request.body' "$LEFTOVERS_WORKFLOW" || false
	[[ "$TEXT" == *'the `leftovers` workflow runs `$P leftovers <pr>`'* ]] || false
	[[ "$TEXT" == *'`pull_request_target`'* ]] || false
}

# A new issue type must keep the fields that a leftover issue and
# requirements read, so leftovers keep working when the taxonomy grows.
@test "every issue form has the Scope dropdown and the criteria field that a leftover issue keeps" {
	for form in "$ROOT"/.github/ISSUE_TEMPLATE/*.yml; do
		[ "$(basename "$form")" = config.yml ] && continue
		[ "$(yq '.body[] | select(.id == "scope") | .attributes.label' "$form")" = Scope ] || {
			echo "$form has no Scope dropdown."
			return 1
		}
		yq -e '.body[] | select(.attributes.label == "Done when" or .attributes.label == "Acceptance criteria")' "$form" >/dev/null || {
			echo "$form has no \"Done when\" or \"Acceptance criteria\" field."
			return 1
		}
	done
	grep -qF '### (Done when|Acceptance criteria)' "$SCRIPT"
}

@test "the growth rules name the files that own each step" {
	section Leftovers | grep -qF '`scripts/markers-check.sh`'
	[ -f "$ROOT/scripts/markers-check.sh" ]
	section Leftovers | grep -qF '`tests/fixtures/calibration/followup/true-<name>.txt`'
	[ -d "$DIR/tests/fixtures/calibration/followup" ]
	# Each label line that discover sends starts a followup fixture.
	for file in "$DIR"/tests/fixtures/calibration/followup/*.txt; do
		head -n 1 "$file" | grep -qE '^[A-Z][^:]* of the pull request:$|^Reason for a rejected review finding:$' || {
			echo "$file starts with no label line of discover."
			return 1
		}
	done
	grep -qF '"Reason for a rejected review finding"' "$SCRIPT"
	grep -qF 'label="$src of the pull request"' "$SCRIPT"
}
