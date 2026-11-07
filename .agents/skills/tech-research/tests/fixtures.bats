#!/usr/bin/env bats

# The check of research.sh keeps every research folder well formed, so that
# a reader can trust a finding, its source and its status. This file pins
# each rule of the check to one fixture. fixtures/good is a research root
# that must pass. Each fixtures/bad/<case>/ adds one defect to a copy of it
# with defect.diff, and expect.txt lists every problem line that the check
# must print, with paths relative to the root. No LLM, no network.

setup() {
	SKILL_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
	R="$SKILL_DIR/scripts/research.sh"
	GOOD="$SKILL_DIR/tests/fixtures/good"
	BAD="$SKILL_DIR/tests/fixtures/bad"
	export RESEARCH_TODAY=2026-11-06
}

# Apply the defect of the case $1 to a fresh copy of the good root, and
# print the path of the copy. git apply works here like patch: the copy
# is not a repository, and GIT_DIR from a commit hook must not leak in.
bad_root() {
	local root="$BATS_TEST_TMPDIR/$1"
	cp -R "$GOOD" "$root"
	(cd "$root" && unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE &&
		GIT_CEILING_DIRECTORIES=$BATS_TEST_TMPDIR git apply "$BAD/$1/defect.diff") || return 1
	echo "$root"
}

@test "check passes the good fixtures" {
	RESEARCH_ROOT="$GOOD" run "$R" check
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "check passes each good research on its own" {
	for dir in "$GOOD"/*/; do
		RESEARCH_ROOT="$GOOD" run "$R" check "$(basename "$dir")"
		[ "$status" -eq 0 ] || {
			echo "$(basename "$dir"): $output"
			return 1
		}
	done
}

@test "there are bad fixtures, and each has a diff and an expectation" {
	count=0
	for dir in "$BAD"/*/; do
		[ -s "$dir/defect.diff" ] && [ -s "$dir/expect.txt" ] || {
			echo "$dir needs defect.diff and expect.txt."
			return 1
		}
		count=$((count + 1))
	done
	[ "$count" -ge 30 ]
}

@test "check prints exactly the expected problems for each bad fixture" {
	failed=""
	for dir in "$BAD"/*/; do
		name=$(basename "$dir")
		root=$(bad_root "$name") || {
			failed+="$name: defect.diff does not apply."$'\n'
			continue
		}
		RESEARCH_ROOT="$root" run "$R" check
		actual=$(sed "s|$root/||g" <<<"$output" | LC_ALL=C sort)
		expected=$(LC_ALL=C sort "$dir/expect.txt")
		if [ "$status" -ne 1 ] || [ "$actual" != "$expected" ]; then
			failed+="$name (exit $status):"$'\n'"$(diff <(echo "$expected") <(echo "$actual") || true)"$'\n'
		fi
	done
	[ -z "$failed" ] || {
		printf '%s' "$failed"
		return 1
	}
}
