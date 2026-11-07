#!/usr/bin/env bats

# scripts/skill-drift.sh runs the drift tests of the skills, so a skill and
# the files it describes cannot drift apart unseen. Pre-commit passes the
# changed files, and the script then runs only the tests that these files
# can affect. A skill folder and the tests/<test>.watch file of a test file
# say which files affect it. Here a fake bats records which tests run.

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

setup() {
	sandbox skill-drift.sh
	S=scripts/skill-drift.sh
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

@test "without files, runs all test files of a skill in one call under a header" {
	skill alpha a b
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '==> alpha\nran %s/a.bats %s/b.bats' "$A" "$A")" ]
	[ "$(calls)" = "bats $A/a.bats $A/b.bats" ]
}

@test "without files, runs every skill in name order, each under its own header" {
	skill beta c
	skill alpha a
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '==> alpha\nran %s/a.bats\n==> beta\nran %s/c.bats' "$A" "$B")" ]
	[ "$(calls)" = "$(printf 'bats %s/a.bats\nbats %s/c.bats' "$A" "$B")" ]
}

@test "skips a skill without test files, and prints no header for it" {
	skill empty
	skill alpha a
	watch alpha a scripts/foo.sh
	mkdir -p .agents/skills/watchonly/tests
	echo scripts/foo.sh >.agents/skills/watchonly/tests/x.watch
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '==> alpha\nran %s/a.bats' "$A")" ]
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
	[ "$output" = "$(printf '==> alpha\nran %s/a.bats %s/b.bats' "$A" "$A")" ]
	[ "$(calls)" = "bats $A/a.bats $A/b.bats" ]
}

@test "a changed file that a .watch line names runs the test file with that .watch file" {
	skill alpha a
	watch alpha a scripts/foo.sh
	run "$S" scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '==> alpha\nran %s/a.bats' "$A")" ]
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

@test "a .watch line can name the folder of another skill" {
	skill alpha a
	skill beta c
	watch beta c .agents/skills/alpha/
	run "$S" .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(printf 'bats %s/a.bats\nbats %s/c.bats' "$A" "$B")" ]
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

@test "runs the tests that any of several changed files affect, in one call per skill" {
	skill alpha a b
	watch alpha a scripts/foo.sh
	watch alpha b scripts/bar.sh
	run "$S" README.md scripts/bar.sh scripts/foo.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats $A/a.bats $A/b.bats" ]
}

@test "runs no bats and exits 0 when no file affects a test" {
	skill alpha a
	watch alpha a scripts/foo.sh
	run "$S" README.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -z "$(calls)" ]
}

@test "exits 1 when a bats call fails, and still runs the other skills" {
	skill alpha a
	skill bad x
	skill zeta z
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "==> alpha"
	has "$output" "==> bad"
	has "$output" "==> zeta"
	[ "$(calls | wc -l | tr -d ' ')" -eq 3 ]
}
