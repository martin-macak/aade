#!/usr/bin/env bats

# Drift tests for the issue-authoring skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here, and no test calls
# GitHub.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	SKILL="$ROOT/.agents/skills/issue-authoring/SKILL.md"
	LABELS="$ROOT/.github/labels.yml"
	FORMS="$ROOT/.github/ISSUE_TEMPLATE"
	PR_TEMPLATE="$ROOT/.github/pull_request_template.md"
	MISE="$ROOT/mise.toml"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

# Print the lines of the first "sh" code block of SKILL.md.
example() {
	awk '/^```sh$/ { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL"
}

@test "the folder, the front matter name and the Claude Code path agree" {
	dir=$(cd "$BATS_TEST_DIRNAME/.." && pwd -P)
	[ "$(yq --front-matter=extract '.name' "$SKILL")" = "$(basename "$dir")" ]
	[ "$(cd "$ROOT/.claude/skills/$(basename "$dir")" && pwd -P)" = "$dir" ]
}

@test "the mise tasks in the skill exist, and check runs taxonomy:check" {
	for task in issue:new labels:sync taxonomy:check; do
		yq -p toml -e ".tasks[\"$task\"]" "$MISE" >/dev/null || {
			echo "mise.toml has no task $task."
			return 1
		}
		[[ "$TEXT" == *"mise run $task"* ]] || false
	done
	yq -p toml '.tasks.check.depends[]' "$MISE" | grep -qx taxonomy:check
}

@test "the workflows that the skill names exist and call the scripts" {
	grep -qF 'scripts/issue-scope-label.sh' "$ROOT/.github/workflows/issue-scope.yml"
	grep -qF 'scripts/labels-sync.sh' "$ROOT/.github/workflows/labels-sync.yml"
	[[ "$TEXT" == *'`issue-scope` workflow'* && "$TEXT" == *'`labels-sync` workflow'* ]] || false
}

@test "the type mapping in the skill matches labels.yml" {
	for pair in enhancement:feat bug:fix; do
		desc=$(yq ".[] | select(.name == \"type:${pair%%:*}\") | .description" "$LABELS")
		[[ "$desc" == *"Commit type ${pair#*:}."* ]] || false
		[[ "$TEXT" == *"\`type:${pair%%:*}\` becomes \`${pair#*:}\`"* ]] || false
	done
}

@test "every type label has a form at the path the skill names" {
	[[ "$TEXT" == *'`.github/ISSUE_TEMPLATE/<type>.yml`'* ]] || false
	for type in $(yq '.[].name | select(test("^type:")) | sub("^type:"; "")' "$LABELS"); do
		[ -f "$FORMS/$type.yml" ]
	done
}

@test "the skill lists no scope values, because labels.yml owns them" {
	for scope in $(yq '.[].name | select(test("^scope:"))' "$LABELS"); do
		if grep -qF "\`$scope\`" "$SKILL"; then
			echo "SKILL.md lists $scope. Point to labels.yml instead."
			return 1
		fi
	done
}

@test "the example uses a form, a known scope and every required field" {
	type=$(example | sed -nE 's/^mise run issue:new ([a-z]+) .*/\1/p')
	form="$FORMS/$type.yml"
	[ -f "$form" ]
	scope=$(example | sed -n 's/^scope: //p')
	yq -e ".[] | select(.name == \"scope:$scope\")" "$LABELS" >/dev/null
	for id in $(yq '.body[] | select(.validations.required == true) | .id' "$form"); do
		example | grep -q "^$id:" || {
			echo "The example lacks the required field $id of $type."
			return 1
		}
	done
}

@test "the PR template has the sections that the skill names" {
	grep -qx 'Closes #' "$PR_TEMPLATE"
	grep -qx '## Notes' "$PR_TEMPLATE"
	grep -qF 'type(scope): summary' "$PR_TEMPLATE"
	[[ "$TEXT" == *'`type(scope): summary`'* && "$TEXT" == *'`Closes #<issue>`'* ]] || false
	# pr-shepherd defines the Requirements format, so this skill only points there.
	grep -qx '## Requirements' "$PR_TEMPLATE"
	[ -f "$ROOT/.agents/skills/pr-shepherd/SKILL.md" ]
	[[ "$TEXT" == *'The `pr-shepherd` skill defines the format of the Requirements and Verify sections'* ]] || false
	! grep -qE '^- \[.\] R[0-9]' "$SKILL" || false
}

# The behavior of the two scripts has its own suites in tests/scripts. This
# test only checks that the real chore form and the scope script still agree.
@test "the helper renders the headings that the scope workflow reads" {
	cd "$ROOT"
	body=$(printf 'title: t\nscope: %s\nwhat: w\ndone: d\n' "$(yq '.[].name | select(test("^scope:")) | sub("^scope:"; "")' "$LABELS" | head -n 1)" |
		scripts/issue-new.sh chore --dry-run)
	grep -qx '### Scope' <<<"$body"
	grep -q '^Labels: type:chore scope:' <<<"$body"
	# The scope script matches this exact heading.
	grep -qF '"### Scope"' "$ROOT/scripts/issue-scope-label.sh"
}

@test "the skill keeps the body format rule, and pr-shepherd points to it" {
	[[ "$TEXT" == *'write each paragraph, list item and reference to an issue or PR on one line'* ]] || false
	[[ "$TEXT" == *'Keep hard wraps in the Markdown files of the repository'* ]] || false
	SHEPHERD=$(tr '\n' ' ' <"$ROOT/.agents/skills/pr-shepherd/SKILL.md" | tr -s ' ')
	[[ "$SHEPHERD" == *'the "Body format" section of the `issue-authoring` skill'* ]] || false
	grep -qx '## Body format' "$SKILL"
}

@test "the YAML example writes each paragraph of a body field on one line" {
	# Inside a "key: |" block, a line that follows another prose line
	# continues a hard-wrapped paragraph. List items may follow each other.
	wrapped=$(example | awk '
		/^[a-z_]+: \|/ { block = 1; prev = ""; next }
		/^[a-z_]+:/ { block = 0 }
		block && /^  [^ -]/ && prev ~ /^  [^ ]/ { print }
		block { prev = $0 }')
	[ -z "$wrapped" ] || {
		echo "The example hard-wraps a body paragraph at: $wrapped"
		return 1
	}
}
