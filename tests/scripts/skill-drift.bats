#!/usr/bin/env bats

# scripts/skill-drift.sh runs the drift tests of the skills, so a skill and
# the files it describes cannot drift apart unseen. Pre-commit passes the
# changed files, and the script then runs only the tests that these files
# can affect. A skill folder and the tests/<test>.watch file of a test file
# say which files affect it. Here a fake bats records which tests run. The
# script runs the test files through script-tests.sh bats, one at a time
# here (TEST_JOBS=1), so the calls keep their order.

load helpers/common

# Create the skill $1 with the test files $2, $3, ... (names without .bats).
skill() {
	local name=$1 test
	shift
	echo "# $name" | fixture ".agents/skills/$name/SKILL.md"
	for test in "$@"; do
		echo '#!/usr/bin/env bats' | fixture ".agents/skills/$name/tests/$test.bats"
	done
}

# Write the .watch file of the test $2 of the skill $1: one line per argument.
watch() {
	local name=$1 test=$2
	shift 2
	printf '%s\n' "$@" | fixture ".agents/skills/$name/tests/$test.watch"
}

# Print the output of a run that ran the test files $@, and passed.
ran() {
	local test
	for test in "$@"; do
		printf '==> %s\nran %s\n' "$test" "$test"
	done
	echo "script-tests: $# suites passed."
}

# Print the calls of the fake bats for the test files $@.
bats_calls() {
	printf 'bats %s\n' "$@"
}

setup() {
	sandbox skill-drift.sh script-tests.sh
	S=scripts/skill-drift.sh
	export TEST_JOBS=1
	# The fake prints what it ran. A skill folder named bad makes it fail.
	fake bats 'echo "ran $*"; case "$*" in *"/bad/tests/"*) exit 1 ;; esac'
	A=.agents/skills/alpha/tests
	B=.agents/skills/beta/tests
}

@test "fails with exit code 2 outside the repository root, and runs no test" {
	run "$S"
	[ "$status" -eq 2 ]
	has "$output" "Run skill-drift.sh from the repository root."
	[ -z "$(calls)" ]
}

@test "without files, runs each test file of a skill under its own header" {
	skill alpha a b
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(ran "$A/a.bats" "$A/b.bats")" ]
	[ "$(calls)" = "$(bats_calls "$A/a.bats" "$A/b.bats")" ]
}

@test "without files, runs every skill in name order, each under its own header" {
	skill beta c
	skill alpha a
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(ran "$A/a.bats" "$B/c.bats")" ]
	[ "$(calls)" = "$(bats_calls "$A/a.bats" "$B/c.bats")" ]
}

@test "skips a skill without test files, and prints no header for it" {
	skill empty
	skill alpha a
	watch alpha a scripts/foo.sh
	mkdir -p .agents/skills/watchonly/tests
	echo scripts/foo.sh >.agents/skills/watchonly/tests/x.watch
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(ran "$A/a.bats")" ]
	run "$S" .agents/skills/empty/SKILL.md scripts/foo.sh
	[ "$status" -eq 0 ]
	lacks "$output" "empty"
	lacks "$output" "watchonly"
}

@test "a changed file in a skill folder runs all tests of that skill, and no other" {
	skill alpha a b
	skill beta c
	run "$S" .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$output" = "$(ran "$A/a.bats" "$A/b.bats")" ]
	[ "$(calls)" = "$(bats_calls "$A/a.bats" "$A/b.bats")" ]
}

@test "a changed file that a .watch line names runs the test file with that .watch file" {
	skill alpha a
	watch alpha a scripts/foo.sh
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$output" = "$(ran "$A/a.bats")" ]
}

@test "a .watch file does not select the sibling test files" {
	skill alpha a b
	watch alpha a scripts/foo.sh
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/a.bats" ]
}

@test "a .watch file selects only its own test, even when a sibling watches another file" {
	skill alpha a b
	watch alpha a scripts/foo.sh
	watch alpha b scripts/bar.sh
	run "$S" scripts/bar.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/b.bats" ]
}

@test "a .watch line that ends with a slash covers the whole folder" {
	skill alpha a
	watch alpha a docs/
	run "$S" docs/deep/page.md
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/a.bats" ]
}

@test "a .watch line that ends with a slash does not cover a folder with a longer name" {
	skill alpha a
	watch alpha a docs/
	run "$S" docs-old/page.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$(calls)" ]
}

@test "a .watch line without a slash matches only that path, not a longer name" {
	skill alpha a
	watch alpha a scripts/foo.sh
	run "$S" scripts/foo.sh.bak scripts/foo.shx
	[ "$status" -eq 0 ]
	[ -z "$(calls)" ]
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/a.bats" ]
}

@test "a .watch line can name the folder of another skill" {
	skill alpha a
	skill beta c
	watch beta c .agents/skills/alpha/
	run "$S" .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(bats_calls "$A/a.bats" "$B/c.bats")" ]
}

@test "ignores comments and blank lines in a .watch file" {
	skill alpha a
	# A blank line would match every path, and a comment would match its own text.
	printf '#notes\n\n   \nscripts/foo.sh\n' | fixture "$A/a.watch"
	run "$S" README.md "#notes.md" "   odd.md"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$(calls)" ]
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/a.bats" ]
}

@test "a skill without a .watch file runs only for files in its folder" {
	skill alpha a
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$(calls)" ]
}

@test "runs the tests that any of several changed files affect" {
	skill alpha a b
	watch alpha a scripts/foo.sh
	watch alpha b scripts/bar.sh
	run "$S" README.md scripts/bar.sh scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(bats_calls "$A/a.bats" "$A/b.bats")" ]
}

@test "runs no bats and exits 0 when no file affects a test" {
	skill alpha a
	watch alpha a scripts/foo.sh
	run "$S" README.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$(calls)" ]
}

@test "exits 2 and runs no test when bats is missing" {
	skill alpha a
	unfake bats
	run env PATH="$(path_without bats)" "$S"
	[ "$status" -eq 2 ]
	[ "$output" = "skill-drift.sh needs bats on PATH. Run it through mise: mise run skills:drift" ]
}

@test "exits 1 when a bats call fails, still runs the other skills, and names the failed file" {
	skill alpha a
	skill bad x
	skill zeta z
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "==> $A/a.bats"
	has "$output" "==> .agents/skills/bad/tests/x.bats"
	has "$output" "==> .agents/skills/zeta/tests/z.bats"
	has "$output" "script-tests: 1 of 3 suites failed: .agents/skills/bad/tests/x.bats"
	[ "$(calls | wc -l | tr -d ' ')" -eq 3 ]
}

@test "--list: prints the affected test files and runs nothing" {
	skill alpha a b
	skill beta c
	watch beta c mise.toml
	run "$S" --list mise.toml .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' "$A/a.bats" "$A/b.bats" "$B/c.bats")" ]
	[ -z "$(calls)" ]
}

@test "--list: works without bats on PATH, as in the classify job of CI" {
	skill alpha a
	unfake bats
	run env PATH="$(path_without bats)" "$S" --list .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$output" = "$A/a.bats" ]
}
