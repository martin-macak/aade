#!/usr/bin/env bats

# scripts/markers-check.sh keeps task markers out of tracked files. A marker
# is one of four words used as a work note, in a call form or right after a
# comment opener. Work notes belong in the "## Leftovers" section of the
# pull request. The pre-commit hook passes the staged files. Without files,
# the script checks every file of git ls-files, as CI does. This suite
# holds no marker word: it builds the words at run time, so the check
# passes on this file.

bats_require_minimum_version 1.5.0

load helpers/common

setup() {
	sandbox markers-check.sh
	S=scripts/markers-check.sh
	# The four marker words. Each is split in the source, so no line of this
	# file matches the check.
	WORDS=(TO""DO FIX""ME XX""X HA""CK)
}

# Write the file $1 below $SANDBOX, one line per further argument.
lines() {
	local name=$1
	shift
	printf '%s\n' "$@" | fixture "$name"
}

# Print the text $1 in lower case.
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

# Scan a file with the one line $1. The check must flag it, and print the
# line with its file name and number.
flags() {
	lines hit.txt "$1"
	run --separate-stderr "$S" hit.txt
	[ "$status" -eq 1 ] || { echo "not flagged: $1"; false; }
	[ "$output" = "hit.txt:1: $1" ] || { echo "wrong output for: $1"; echo "$output"; false; }
}

# Scan a file with the one line $1. The check must pass it.
passes() {
	lines hit.txt "$1"
	run --separate-stderr "$S" hit.txt
	[ "$status" -eq 0 ] || { echo "flagged: $1"; echo "$output"; false; }
	[ -z "$output" ] || { echo "output for: $1"; echo "$output"; false; }
}

@test "passes a file without a marker and prints nothing" {
	lines clean.txt "plain text" "const a = 1;" "# an ordinary comment"
	run --separate-stderr "$S" clean.txt
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "call form: flags each marker word with a colon" {
	for w in "${WORDS[@]}"; do
		flags "$w: later"
		flags "x = 1 $w: later"
		flags "$w : later"
	done
}

@test "call form: flags each marker word with a bracket, such as the Kotlin call" {
	for w in "${WORDS[@]}"; do
		flags "$w()"
		flags "$w(owner): later"
		flags "x = $w (reason)"
	done
}

@test "comment form: flags each marker word after a hash" {
	for w in "${WORDS[@]}"; do
		flags "# $w"
		flags "#$w later"
		flags "    # $w later"
	done
}

@test "comment form: flags each marker word after two slashes" {
	for w in "${WORDS[@]}"; do
		flags "// $w"
		flags "x = 1 // $w later"
	done
}

@test "comment form: flags each marker word after a block comment opener" {
	for w in "${WORDS[@]}"; do
		flags "/* $w */"
		flags "/*$w"
	done
}

@test "comment form: flags each marker word on a block comment continuation line" {
	for w in "${WORDS[@]}"; do
		flags " * $w"
		flags " *   $w later"
	done
}

@test "comment form: flags each marker word after an HTML comment opener" {
	for w in "${WORDS[@]}"; do
		flags "<!-- $w -->"
		flags "<!--$w"
	done
}

@test "ignores a marker word at the start of a longer word" {
	for w in "${WORDS[@]}"; do
		passes "${w}S"
		passes "${w}S: later"
		passes "# ${w}S"
		passes "/* ${w}ING */"
	done
	passes "XX""XL"
	passes "HA""CKATHON: Friday"
	passes "// XX""XL"
}

@test "ignores a marker word inside a longer word or an identifier" {
	for w in "${WORDS[@]}"; do
		passes "my$w: later"
		passes "MY_$w: later"
		passes "x = ${w}_COUNT(1)"
	done
	passes "GRADLE_XX""X_KEY"
}

@test "ignores lower case and mixed case words" {
	for w in "${WORDS[@]}"; do
		low=$(lower "$w")
		passes "$low: later"
		passes "# $low"
		passes "// ${low}(owner)"
		passes "${w:0:1}${low:1}: later"
	done
}

@test "ignores prose that names the marker words without a colon or a bracket" {
	passes "Never leave ${WORDS[0]}, ${WORDS[1]}, ${WORDS[2]} or ${WORDS[3]} markers."
	passes "The word ${WORDS[0]} marks work that is not done."
	passes "x = \"${WORDS[3]}\""
}

@test "prints each hit as file:line: text on stdout, and only the hint on stderr" {
	lines out.txt "first" "second" "x // ${WORDS[0]}: why: because"
	run --separate-stderr "$S" out.txt
	[ "$status" -eq 1 ]
	[ "$output" = "out.txt:3: x // ${WORDS[0]}: why: because" ]
	[ "${#stderr_lines[@]}" -eq 1 ]
	has "$stderr" "## Leftovers"
}

@test "reports every hit of several files in order, and not a clean file" {
	lines a.kt "val a = 1" "// ${WORDS[0]}: one" "val b = 2"
	lines b.kt "val c = 3"
	lines c.sh "#!/bin/sh" "" "# ${WORDS[3]} around it" "echo hi" "x=1 ${WORDS[1]}(owner)"
	run --separate-stderr "$S" a.kt b.kt c.sh
	[ "$status" -eq 1 ]
	[ "$output" = "a.kt:2: // ${WORDS[0]}: one
c.sh:3: # ${WORDS[3]} around it
c.sh:5: x=1 ${WORDS[1]}(owner)" ]
}

@test "checks the files that come after a file with a marker" {
	lines first.txt "# ${WORDS[2]}"
	lines last.txt "// ${WORDS[1]}"
	run --separate-stderr "$S" first.txt last.txt
	[ "$status" -eq 1 ]
	[ "$output" = "first.txt:1: # ${WORDS[2]}
last.txt:1: // ${WORDS[1]}" ]
}

@test "passes several files that have no marker" {
	lines a.kt "val a = 1"
	lines b.md "Some prose."
	run --separate-stderr "$S" a.kt b.md
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "skips a file that does not exist, such as a deleted file" {
	run --separate-stderr "$S" missing.txt
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "skips a missing file and still reports the marker of another file" {
	lines hit.txt "# ${WORDS[0]}"
	run --separate-stderr "$S" missing.txt hit.txt
	[ "$status" -eq 1 ]
	[ "$output" = "hit.txt:1: # ${WORDS[0]}" ]
}

@test "skips a directory and a symlink that points nowhere" {
	mkdir folder
	ln -s nowhere dangling
	run --separate-stderr "$S" folder dangling
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "skips a binary file that holds a marker" {
	printf 'x\000y # %s\n' "${WORDS[0]}" >binary.dat
	run --separate-stderr "$S" binary.dat
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "reads a text file with stray bytes as text" {
	printf '\377\376 // %s\n' "${WORDS[1]}" >stray.txt
	run --separate-stderr "$S" stray.txt
	[ "$status" -eq 1 ]
	has "$output" "stray.txt:1: "
	has "$output" "// ${WORDS[1]}"
}

@test "reads a symlink to a file as that file" {
	lines real.txt "# ${WORDS[0]}"
	ln -s real.txt link.txt
	run --separate-stderr "$S" link.txt
	[ "$status" -eq 1 ]
	[ "$output" = "link.txt:1: # ${WORDS[0]}" ]
}

@test "without files, checks every tracked file" {
	lines clean.txt "plain text"
	lines sub/dir/hit.sh "echo hi" "# ${WORDS[0]}"
	lines other.md "Some prose."
	git add -A
	run --separate-stderr "$S"
	[ "$status" -eq 1 ]
	[ "$output" = "sub/dir/hit.sh:2: # ${WORDS[0]}" ]
}

@test "points to the Leftovers section of the pull request when it finds a marker" {
	lines hit.txt "# ${WORDS[0]}"
	run --separate-stderr "$S" hit.txt
	[ "$status" -eq 1 ]
	[ "$stderr" = 'Move each follow-up to the "## Leftovers" section of the pull request. The pr-shepherd skill explains the format.' ]
	lines clean.txt "plain text"
	run --separate-stderr "$S" clean.txt
	[ -z "$stderr" ]
}

@test "without files, reads a tracked symlink only through its tracked target" {
	lines target.md "# ${WORDS[0]}"
	ln -s target.md link.md
	git add -A
	run --separate-stderr "$S"
	[ "$status" -eq 1 ]
	[ "$output" = "target.md:1: # ${WORDS[0]}" ]
}

@test "without files, passes when no tracked file has a marker" {
	lines clean.txt "plain text"
	git add -A
	run --separate-stderr "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "without files, skips a file that git does not track" {
	lines clean.txt "plain text"
	git add -A
	lines untracked.txt "# ${WORDS[0]}"
	run --separate-stderr "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "without files, skips a tracked file that was deleted" {
	lines gone.txt "# ${WORDS[0]}"
	git add -A
	rm gone.txt
	run --separate-stderr "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "without files, reads a path with a space in its name" {
	lines "my dir/a b.txt" "# ${WORDS[0]}"
	git add -A
	run --separate-stderr "$S"
	[ "$status" -eq 1 ]
	[ "$output" = "my dir/a b.txt:1: # ${WORDS[0]}" ]
}

@test "with files, checks only the named files" {
	lines clean.txt "plain text"
	lines hit.txt "# ${WORDS[0]}"
	git add -A
	run --separate-stderr "$S" clean.txt
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "without files, outside a git repository, exits 2" {
	export GIT_CEILING_DIRECTORIES="$BATS_TEST_TMPDIR"
	mkdir "$BATS_TEST_TMPDIR/plain"
	cd "$BATS_TEST_TMPDIR/plain"
	run "$SANDBOX/$S"
	[ "$status" -eq 2 ]
}

@test "exits 2 when grep fails" {
	fake grep 'exit 2'
	lines a.txt "plain text"
	run --separate-stderr "$S" a.txt
	[ "$status" -eq 2 ]
}

@test "exit 2 wins over exit 1, in either order, and the hits still print" {
	REAL_GREP=$(command -v grep)
	export REAL_GREP
	fake grep 'case "$*" in *bad.txt*) exit 2 ;; esac; exec "$REAL_GREP" "$@"'
	lines bad.txt "plain text"
	lines hit.txt "# ${WORDS[0]}"
	run --separate-stderr "$S" bad.txt hit.txt
	[ "$status" -eq 2 ]
	[ "$output" = "hit.txt:1: # ${WORDS[0]}" ]
	run --separate-stderr "$S" hit.txt bad.txt
	[ "$status" -eq 2 ]
	[ "$output" = "hit.txt:1: # ${WORDS[0]}" ]
}

@test "the script and this suite hold no marker" {
	run --separate-stderr "$S" "$ROOT/scripts/markers-check.sh" "$BATS_TEST_FILENAME"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}
