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
		[[ "$TEXT" == *"mise run $task"* ]]
	done
	yq -p toml '.tasks.check.depends[]' "$MISE" | grep -qx taxonomy:check
}

@test "the workflows that the skill names exist and call the scripts" {
	grep -qF 'scripts/issue-scope-label.sh' "$ROOT/.github/workflows/issue-scope.yml"
	grep -qF 'scripts/labels-sync.sh' "$ROOT/.github/workflows/labels-sync.yml"
	[[ "$TEXT" == *'`issue-scope` workflow'* && "$TEXT" == *'`labels-sync` workflow'* ]]
}

@test "the type mapping in the skill matches labels.yml" {
	for pair in enhancement:feat bug:fix; do
		desc=$(yq ".[] | select(.name == \"type:${pair%%:*}\") | .description" "$LABELS")
		[[ "$desc" == *"Commit type ${pair#*:}."* ]]
		[[ "$TEXT" == *"\`type:${pair%%:*}\` becomes \`${pair#*:}\`"* ]]
	done
}

@test "every type label has a form at the path the skill names" {
	[[ "$TEXT" == *'`.github/ISSUE_TEMPLATE/<type>.yml`'* ]]
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
	[[ "$TEXT" == *'`type(scope): summary`'* && "$TEXT" == *'`Closes #<issue>`'* ]]
}

@test "the helper renders the headings that the scope workflow reads" {
	cd "$ROOT"
	body=$(printf 'title: t\nscope: %s\nwhat: w\ndone: d\n' "$(yq '.[].name | select(test("^scope:")) | sub("^scope:"; "")' "$LABELS" | head -n 1)" |
		scripts/issue-new.sh chore --dry-run)
	grep -qx '### Scope' <<<"$body"
	grep -q '^Labels: type:chore scope:' <<<"$body"
}

@test "the helper rejects a missing required field and an unknown key" {
	cd "$ROOT"
	run scripts/issue-new.sh chore --dry-run <<<$'title: t\nbogus: 1'
	[ "$status" -eq 2 ]
	[[ "$output" == *"bogus: the chore form has no such field."* ]]
	[[ "$output" == *"what: required."* ]]
}

# A stub gh on PATH returns the issue JSON in $ISSUE_JSON and records its
# other calls in $BATS_TEST_TMPDIR/gh.log.
stub_gh() {
	mkdir -p "$BATS_TEST_TMPDIR/bin"
	cat >"$BATS_TEST_TMPDIR/bin/gh" <<'STUB'
#!/usr/bin/env bash
if [[ "$1 $2" == "issue view" ]]; then
	printf '%s' "$ISSUE_JSON"
else
	echo "$*" >>"$BATS_TEST_TMPDIR/gh.log"
fi
STUB
	chmod +x "$BATS_TEST_TMPDIR/bin/gh"
	PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "the scope script swaps the scope label for the Scope section of the body" {
	cd "$ROOT"
	stub_gh
	scope=$(yq '.[].name | select(test("^scope:")) | sub("^scope:"; "")' "$LABELS" | head -n 1)
	ISSUE_JSON=$(jq -n --arg body $'### Scope\n\n'"$scope"$'\n\n### What and why\n\nw' \
		'{body: $body, labels: [{name: "type:chore"}, {name: "scope:old"}]}')
	export ISSUE_JSON
	run scripts/issue-scope-label.sh 7
	[ "$status" -eq 0 ]
	grep -qx "issue edit 7 --remove-label scope:old --add-label scope:$scope" "$BATS_TEST_TMPDIR/gh.log"
}

@test "the scope script rejects a Scope section that is not a scope name" {
	cd "$ROOT"
	stub_gh
	ISSUE_JSON=$(jq -n --arg body $'### Scope\n\nx") | del(.)\n' '{body: $body, labels: []}')
	export ISSUE_JSON
	run scripts/issue-scope-label.sh 7
	[ "$status" -eq 1 ]
	[ ! -f "$BATS_TEST_TMPDIR/gh.log" ]
}
