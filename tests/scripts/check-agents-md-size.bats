#!/usr/bin/env bats

# scripts/check-agents-md-size.sh keeps every AGENTS.md short, because
# agents load each line into their context. The root file has MAX_LINES,
# a nested file MAX_NESTED_LINES. The pre-commit hook passes the changed
# files. Without files the script checks every AGENTS.md that git sees.

load helpers/common

setup() {
	sandbox check-agents-md-size.sh
	S=scripts/check-agents-md-size.sh
	ROOT_MAX=$(sed -n 's/^MAX_LINES=//p' "$S")
	NESTED_MAX=$(sed -n 's/^MAX_NESTED_LINES=//p' "$S")
	MOVE="Move task-specific content into a skill. See the knowledge-curator skill."
}

# Write the file $1 with $2 lines.
lines() {
	mkdir -p "$(dirname "$1")"
	seq "$2" >"$1"
}

@test "the limits are positive numbers, and nested files get the lower one" {
	[[ "$ROOT_MAX" =~ ^[0-9]+$ && "$NESTED_MAX" =~ ^[0-9]+$ ]] || false
	((NESTED_MAX < ROOT_MAX)) || false
}

@test "passes a root AGENTS.md at the limit" {
	lines AGENTS.md "$ROOT_MAX"
	run "$S" AGENTS.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "fails a root AGENTS.md one line over the limit and says what to do" {
	lines AGENTS.md $((ROOT_MAX + 1))
	run "$S" AGENTS.md
	[ "$status" -eq 1 ]
	[ "$output" = "AGENTS.md has $((ROOT_MAX + 1)) lines. The limit is $ROOT_MAX.
$MOVE" ]
}

@test "treats ./AGENTS.md as the root file" {
	lines AGENTS.md "$ROOT_MAX"
	run "$S" ./AGENTS.md
	[ "$status" -eq 0 ]
}

@test "applies the nested limit to an AGENTS.md in a subfolder" {
	lines docs/AGENTS.md "$NESTED_MAX"
	run "$S" docs/AGENTS.md
	[ "$status" -eq 0 ]
	lines docs/AGENTS.md $((NESTED_MAX + 1))
	run "$S" docs/AGENTS.md
	[ "$status" -eq 1 ]
	[ "$output" = "docs/AGENTS.md has $((NESTED_MAX + 1)) lines. The limit is $NESTED_MAX.
$MOVE" ]
}

@test "skips a named file that does not exist" {
	run "$S" missing/AGENTS.md
	[ "$status" -eq 0 ]
}

@test "reports every file over its limit, not only the first" {
	lines AGENTS.md $((ROOT_MAX + 1))
	lines a/AGENTS.md $((NESTED_MAX + 1))
	run "$S" AGENTS.md a/AGENTS.md
	[ "$status" -eq 1 ]
	[ "$output" = "AGENTS.md has $((ROOT_MAX + 1)) lines. The limit is $ROOT_MAX.
$MOVE
a/AGENTS.md has $((NESTED_MAX + 1)) lines. The limit is $NESTED_MAX.
$MOVE" ]
}

@test "with files, checks only the named files" {
	lines AGENTS.md 1
	lines big/AGENTS.md $((NESTED_MAX + 1))
	git add -A
	run "$S" AGENTS.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "without arguments checks tracked and untracked AGENTS.md files" {
	lines AGENTS.md 1
	git add AGENTS.md
	lines new/AGENTS.md $((NESTED_MAX + 1))
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" = "new/AGENTS.md has $((NESTED_MAX + 1)) lines. The limit is $NESTED_MAX.
$MOVE" ]
}

@test "without arguments fails a tracked AGENTS.md over its limit" {
	lines AGENTS.md $((ROOT_MAX + 1))
	lines docs/AGENTS.md $((NESTED_MAX + 1))
	git add -A
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" = "AGENTS.md has $((ROOT_MAX + 1)) lines. The limit is $ROOT_MAX.
$MOVE
docs/AGENTS.md has $((NESTED_MAX + 1)) lines. The limit is $NESTED_MAX.
$MOVE" ]
}

@test "without arguments skips AGENTS.md files that git ignores" {
	echo ignored/ >.gitignore
	lines ignored/AGENTS.md $((NESTED_MAX + 1))
	run "$S"
	[ "$status" -eq 0 ]
}
