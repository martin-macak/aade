#!/usr/bin/env bats

# Drift tests for the knowledge-curator skill. Each test compares a fact in
# SKILL.md with the file that owns it. No LLM runs here.

setup() {
	# A commit hook can export GIT_DIR, and git then reports the wrong root.
	ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
	SKILL="$ROOT/.agents/skills/knowledge-curator/SKILL.md"
	RUNNER="$ROOT/.agents/skills/knowledge-curator/scripts/test-skill.sh"
	CONFIG="$ROOT/.pre-commit-config.yaml"
	LINT="$ROOT/scripts/lint-knowledge.sh"
	SIZE="$ROOT/scripts/check-agents-md-size.sh"
	MISE="$ROOT/mise.toml"
	WORKFLOW="$ROOT/.github/workflows/ci.yml"
	RULESET="$ROOT/.github/rulesets/main.json"
	# The prose on one line, so a rewrapped paragraph still matches.
	TEXT=$(tr '\n' ' ' <"$SKILL" | tr -s ' ')
}

# Print the lines of the "## <name>" section of SKILL.md.
section() {
	awk -v head="## $1" '$0 == head { inside = 1; next } inside && /^## / { exit } inside' "$SKILL"
}

# Print the path of each skill folder in .agents/skills.
skill_dirs() {
	local dir
	for dir in "$ROOT"/.agents/skills/*/; do
		[[ -d "$dir" ]] && echo "${dir%/}"
	done
	return 0
}

# Print the test files of every skill, relative to the root.
skill_tests() {
	local dir test
	for dir in $(skill_dirs); do
		for test in "$dir"/tests/*.bats; do
			[[ -f "$test" ]] && echo "${test#"$ROOT"/}"
		done
	done
	return 0
}

@test "the skills table lists every skill folder and nothing else" {
	listed=$(awk '/^Current skills:/ { inside = 1; next } inside && /^## / { exit } inside && /^\| `/' "$SKILL" |
		sed -E 's/^\| `([^`]+)`.*/\1/' | sort)
	folders=$(skill_dirs | xargs -n 1 basename | sort)
	diff <(echo "$listed") <(echo "$folders")
}

@test "the AGENTS.md limits match the size script" {
	root=$(sed -n 's/^MAX_LINES=//p' "$SIZE")
	nested=$(sed -n 's/^MAX_NESTED_LINES=//p' "$SIZE")
	[ -n "$root" ]
	[ -n "$nested" ]
	[[ "$TEXT" == *"The constitution and guardrails. At most $root lines."* ]] || false
	[[ "$TEXT" == *"exceeds \`MAX_LINES\` ($root today)"* ]] || false
	[[ "$TEXT" == *"Purpose, intent and local rules of one folder. At most $nested lines."* ]] || false
	[[ "$TEXT" == *"exceeds \`MAX_NESTED_LINES\` ($nested today)"* ]] || false
}

@test "the SKILL.md limit matches lint-knowledge.sh" {
	limit=$(sed -n 's/^MAX_SKILL_LINES=//p' "$LINT")
	[ -n "$limit" ]
	[[ "$TEXT" == *"Rules and procedures for one domain. At most $limit lines."* ]] || false
	[[ "$TEXT" == *"Keep \`SKILL.md\` under $limit lines."* ]] || false
	[[ "$TEXT" == *"a \`description\`, at most $limit lines;"* ]] || false
}

@test "the hooks run the scripts and tasks that the skill names" {
	hook() { yq ".repos[].hooks[] | select(.id == \"$1\") | .entry" "$CONFIG"; }
	[ "$(hook agents-check)" = "mise run agents:check" ]
	[ "$(hook agents-md-size)" = "mise exec -- scripts/check-agents-md-size.sh" ]
	[ "$(hook knowledge-lint)" = "mise exec -- scripts/lint-knowledge.sh" ]
	[[ "$TEXT" == *'runs `scripts/check-agents-md-size.sh`'* ]] || false
	[[ "$TEXT" == *'runs `scripts/lint-knowledge.sh`'* ]] || false
	[[ "$TEXT" == *'runs `mise run agents:check`'* ]] || false
}

@test "the mise tasks in the skill exist, and check runs every CI check" {
	for task in agents:check agents:link skills:test skills:drift check test; do
		yq -p toml -e ".tasks[\"$task\"]" "$MISE" >/dev/null || {
			echo "mise.toml has no task $task."
			return 1
		}
	done
	[[ "$TEXT" == *'mise run skills:drift'* && "$TEXT" == *'mise run skills:test'* && "$TEXT" == *'mise run agents:link'* ]] || false
	deps=$(yq -p toml '.tasks.check.depends[]' "$MISE")
	for task in agents:check knowledge:size knowledge:lint prose:lint; do
		grep -qx "$task" <<<"$deps" || {
			echo "mise run check does not run $task."
			return 1
		}
	done
	# check holds only the structural checks. The suites run in test.
	for task in skills:drift scripts:test; do
		if grep -qx "$task" <<<"$deps"; then
			echo "mise run check runs the suites of $task. Move them to mise run test."
			return 1
		fi
	done
	[ "$(yq -p toml -oy '.tasks.test.run' "$MISE")" = "scripts/ci-plan.sh test" ]
	grep -qF 'mise run check' "$WORKFLOW"
}

# The ruleset requires the gate job of the CI workflow. A renamed job would
# leave the required check pending, and every merge would block.
@test "the ruleset snapshot requires ci-gate, and the CI workflow has that job" {
	checks=$(jq -r '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context' "$RULESET")
	grep -qx ci-gate <<<"$checks"
	grep -qx pr-shepherd <<<"$checks"
	[ "$(yq '.jobs["ci-gate"].name // "ci-gate"' "$WORKFLOW")" = ci-gate ]
	[ "$(yq '.jobs["ci-gate"].if' "$WORKFLOW")" = 'always()' ]
}

@test "each hook in Enforcement exists, and the count matches its list" {
	ids=$(yq '.repos[].hooks[].id' "$CONFIG")
	hooks=$(section Enforcement | sed -nE 's/^- \*\*`([a-z-]+)`\*\*.*/\1/p')
	[ -n "$hooks" ]
	for hook in $hooks; do
		grep -qx "$hook" <<<"$ids" || {
			echo "Enforcement names the hook $hook, but .pre-commit-config.yaml has no such id."
			return 1
		}
	done
	words=(zero one two three four five six seven eight nine)
	count=$(grep -c '' <<<"$hooks")
	section Enforcement | grep -qi "^${words[count]} pre-commit hooks guard the layer"
}

@test "the test layers in the skill match the runner" {
	for layer in drift triggers knowledge slop; do
		[[ "$TEXT" == *"| \`$layer\` |"* ]] || false
		grep -qE "^$layer\) layer_$layer ;;" "$RUNNER"
	done
}

@test "the test settings in the skill match the runner defaults" {
	for pair in MODEL:haiku RUNS:3 JOBS:4; do
		name=${pair%%:*}
		value=${pair#*:}
		grep -qF "$name=\${SKILL_TEST_$name:-$value}" "$RUNNER"
		[[ "$TEXT" =~ \`SKILL_TEST_$name\`\ \(default\ \`?$value\`?\) ]] || false
	done
	[[ "$TEXT" == *"Each task runs 3 times"* ]] || false
}

@test "the case minimum in the skill matches lint-knowledge.sh" {
	min=$(sed -n 's/^MIN_CASES=//p' "$LINT")
	[ -n "$min" ]
	[[ "$TEXT" == *"at least $min \`+\` and $min \`-\` tasks, and at least $min questions in each skill"* ]] || false
}

# The test hook gets every staged file, and ci-plan.sh picks the suites
# from the .watch files, so no filter in the config can drift.
@test "the test hook passes the staged files to the suite mapping" {
	hook='.repos[].hooks[] | select(.id == "test")'
	[ "$(yq "$hook | .entry" "$CONFIG")" = "mise exec -- scripts/ci-plan.sh test" ]
	[ "$(yq "$hook | .files" "$CONFIG")" = null ]
	[ "$(yq "$hook | .pass_filenames" "$CONFIG")" != false ]
	[ "$(yq "$hook | .require_serial" "$CONFIG")" = true ]
	[ -z "$(yq '.repos[].hooks[] | select(.id == "skill-drift" or .id == "scripts-test") | .id' "$CONFIG")" ]
}

# A test file that reads a path outside its skill must watch that path in
# its .watch file, or a change to the path would skip the test file.
@test "each test file watches every outside path that it reads" {
	missing=""
	for test in $(skill_tests); do
		test="$ROOT/$test"
		name=$(basename "$(dirname "$(dirname "$test")")")
		watch=$(grep -vsE '^(#|[[:space:]]*$)' "${test%.bats}.watch" || true)
		# A path in a test starts with $ROOT/ or "$ROOT"/. A glob ends the path.
		# Comments do not count. A path built from a variable cannot be
		# watched. CI runs every drift test, so it covers it.
		for path in $(grep -vE '^[[:space:]]*#' "$test" | grep -oE '\$ROOT"?/[^"[:space:])]+' |
			sed -E 's/^\$ROOT"?\///; s/\*.*//' | sort -u); do
			[[ "$path" =~ ^[A-Za-z0-9._] ]] || continue
			[[ "$path" == *'$'* || "$path/" == ".agents/skills/$name/"* ]] && continue
			covered=0
			while IFS= read -r entry; do
				# The rule of skill-drift.sh: the same path, or a path below a
				# watched folder.
				[[ -n "$entry" && ("$path" == "$entry" || "$path/" == "$entry" ||
					("$entry" == */ && "$path" == "$entry"*)) ]] && covered=1
			done <<<"$watch"
			((covered)) || missing+="${test#"$ROOT"/} reads $path, but $(basename "${test%.bats}").watch does not list it."$'\n'
		done
	done
	[ -z "$missing" ] || {
		printf '%s' "$missing"
		return 1
	}
}

@test "every skill Makefile includes the shared targets" {
	for dir in $(skill_dirs); do
		grep -qx 'include ../knowledge-curator/scripts/skill.mk' "$dir/Makefile" 2>/dev/null || {
			echo "$dir/Makefile does not include ../knowledge-curator/scripts/skill.mk."
			return 1
		}
	done
}

# A commit hook can export GIT_DIR. A test that asks git for the root then
# gets the wrong one, and a git init then rewrites the real repository.
# The check reads the skill tests and the suites of tests/scripts with their
# helpers, where sandbox runs git init.
@test "no test asks git for the root or creates a repository with GIT_DIR set" {
	cd "$ROOT"
	tests="$(skill_tests) $(ls "$ROOT"/tests/scripts/*.bats "$ROOT"/tests/scripts/helpers/* | sed "s|^$ROOT/||")"
	# This file names the patterns, so it skips itself.
	tests=$(printf '%s\n' $tests | grep -vx '.agents/skills/knowledge-curator/tests/drift.bats')
	inits=$(grep -l 'git init' $tests || true)
	# The sandbox helper runs git init, so an empty list means a broken check.
	[ -n "$inits" ] || {
		echo "No test file runs git init. This check reads the wrong files."
		return 1
	}
	bad=$(grep -l 'show-toplevel' $tests || true)
	for test in $inits; do
		grep -q 'unset GIT_DIR' "$test" || bad+=" $test"
	done
	[ -z "$bad" ] || {
		echo "These tests depend on git's environment: $bad"
		return 1
	}
}
