#!/usr/bin/env bats

# Run shepherd.sh check and requirements against the PR fixtures. A fake gh
# (helpers/gh) serves each case. fixtures/prs/base is a PR that passes.
# Each fixtures/prs/good/<case>/ and fixtures/prs/bad/<case>/ changes some
# files of the base. Each bad case has an expect.txt with every line that
# the check must print. No LLM, no network.

setup() {
	SKILL_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
	S="$SKILL_DIR/scripts/shepherd.sh"
	export SHEPHERD=$S
	export BASE="$SKILL_DIR/tests/fixtures/prs/base"
	GOOD="$SKILL_DIR/tests/fixtures/prs/good"
	BAD="$SKILL_DIR/tests/fixtures/prs/bad"
	export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
	mkdir -p "$BATS_TEST_TMPDIR/bin"
	ln -s "$SKILL_DIR/tests/helpers/gh" "$BATS_TEST_TMPDIR/bin/gh"
	PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "check passes the base PR" {
	export CASE=$BASE
	run "$S" check 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 passes every shepherd rule." ]
}

@test "check passes each good case" {
	failed=""
	for dir in "$GOOD"/*/; do
		export CASE=$dir
		run "$S" check 42
		[ "$status" -eq 0 ] || failed+="$(basename "$dir") (exit $status):"$'\n'"$output"$'\n'
	done
	[ -z "$failed" ] || {
		printf '%s' "$failed"
		return 1
	}
}

@test "there are bad cases, and each has an expectation" {
	count=0
	for dir in "$BAD"/*/; do
		[ -s "$dir/expect.txt" ] || {
			echo "$dir needs expect.txt."
			return 1
		}
		count=$((count + 1))
	done
	[ "$count" -ge 25 ]
}

@test "check prints exactly the expected problems for each bad case" {
	failed=""
	for dir in "$BAD"/*/; do
		name=$(basename "$dir")
		export CASE=$dir
		run "$S" check 42
		actual=$(LC_ALL=C sort <<<"$output")
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

@test "check writes nothing to GitHub" {
	export CASE=$BASE
	run "$S" check 42
	[ ! -f "$GH_LOG" ]
}

@test "requirements prints the R skeleton in issue order, normalised" {
	export CASE=$BASE
	run "$S" requirements 11
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' '## Requirements' '' \
		'- [ ] R1: the check fails on an unticked task' \
		'- [ ] R2: the check fails on a missing evidence line' \
		'- [ ] R3: CI runs the check')" ]
}

@test "requirements reads Acceptance criteria and plain bullets" {
	printf '### Problem\n\np\n\n### Acceptance criteria\n\n- first  item\n* second item\n  - nested is not an item\n\n### Breaking change\n\n- [ ] not an item\n' \
		>"$BATS_TEST_TMPDIR/issue.txt"
	export CASE=$BATS_TEST_TMPDIR
	run "$S" requirements 11
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' '## Requirements' '' '- [ ] R1: first item' '- [ ] R2: second item')" ]
}

@test "requirements exits 1 for an issue without items" {
	printf '### What and why\n\nw\n\n### Done when\n\n_No response_\n' >"$BATS_TEST_TMPDIR/issue.txt"
	export CASE=$BATS_TEST_TMPDIR
	run "$S" requirements 11
	[ "$status" -eq 1 ]
	[[ "$output" == *'Issue #11 has no items under "### Done when" or "### Acceptance criteria".'* ]]
}

@test "a wrong call exits 2 and prints the usage" {
	for args in "" "check" "check abc" "bogus 1" "reply 42 PRRT_bot maybe --reason r"; do
		# shellcheck disable=SC2086 # the arguments split into words.
		export CASE=$BASE
		run "$S" $args
		[ "$status" -eq 2 ] || {
			echo "args '$args': exit $status"
			return 1
		}
	done
	[[ "$output" == *"shepherd.sh check <pr>"* ]]
}

# The case is built here, because git can turn CRLF into LF in a tracked
# fixture.
@test "check passes a body and an issue with CRLF line ends" {
	export CASE=$BATS_TEST_TMPDIR
	sed 's/$/\r/' "$BASE/body.txt" >"$CASE/body.txt"
	sed 's/$/\r/' "$BASE/issue.txt" >"$CASE/issue.txt"
	grep -q $'\r$' "$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "requirements joins the continuation lines of a wrapped issue item" {
	printf '### Done when\n\n- [ ] reject unauthorised requests\n  and keep the audit log\n- [ ] second\n  - nested is not part of it\n\n  after a blank line is not part of it\n' \
		>"$BATS_TEST_TMPDIR/issue.txt"
	export CASE=$BATS_TEST_TMPDIR
	run "$S" requirements 11
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' '## Requirements' '' '- [ ] R1: reject unauthorised requests and keep the audit log' '- [ ] R2: second')" ]
}

@test "check exits 2 when the reviews have a next page, so it never passes on findings it did not see" {
	export CASE=$BATS_TEST_TMPDIR
	jq '.reviewThreads.pageInfo = {hasNextPage: true}' "$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"more than 100 review threads"* ]]
	jq '.reviewThreads.nodes[0].comments.pageInfo = {hasNextPage: true}' "$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 2 ]
}
