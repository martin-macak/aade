#!/usr/bin/env bats

# shepherd.sh keeps a PR honest: it carries every item of its issue, proves
# each one, closes every task and triages every review finding before merge.
# This file covers the read-only commands: the usage errors, requirements
# and check, which CI runs. verify.bats covers the commands that ask
# decisionkit or write to GitHub. No LLM, no network.

# run --separate-stderr needs bats 1.5 or later.
bats_require_minimum_version 1.5.0

# The fake gh (helpers/gh) serves each case. fixtures/prs/base is a PR that
# passes. Each fixtures/prs/good/<case>/ and bad/<case>/ changes some files
# of the base. A bad case has an expect.txt with every line that the check
# must print. The tests below add one case each, in a folder of the test.
ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	# The script runs from a copy of the skill and of the decisionkit skill
	# next to it, so it cannot change the repository.
	SKILL_DIR="$(skill_copy pr-shepherd decisionkit)/pr-shepherd"
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
	[[ "$output" == *'Issue #11 has no items under "### Done when" or "### Acceptance criteria".'* ]] || false
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
	[[ "$output" == *"shepherd.sh check <pr>"* ]] || false
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
	[[ "$output" == *"more than 100 review threads"* ]] || false
	jq '.reviewThreads.nodes[0].comments.pageInfo = {hasNextPage: true}' "$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 2 ]
}

# ------------------------------------------------------- helpers and usage

# Start a case in a folder of the test. The fake gh serves the base for each
# file that the test does not write there. A file <name>.sed or <name>.jq
# edits the base file.
new_case() {
	export CASE="$BATS_TEST_TMPDIR/case"
	mkdir -p "$CASE"
}

# Assert that "shepherd.sh <args>" is a usage error: it exits 2, prints the
# usage and makes no call to GitHub.
usage_error() {
	new_case
	run "$S" "$@"
	[ "$status" -eq 2 ] || {
		echo "'$*': exit $status"
		return 1
	}
	[[ "$output" == *"shepherd.sh check <pr>"* ]] || {
		echo "'$*': no usage text"
		return 1
	}
	[ ! -f "$GH_LOG" ] || {
		echo "'$*': called gh"
		return 1
	}
}

# Write the base body with the evidence line of R2 replaced by the lines in
# the arguments. Each argument is a whole line, with its indent.
r2_evidence() {
	new_case
	EVIDENCE=$(printf '%s\n' "$@") awk '$0 == "  - evidence: tests/" { print ENVIRON["EVIDENCE"]; next } 1' \
		"$BASE/body.txt" >"$CASE/body.txt"
}

@test "a call without a command prints every command and exits 2" {
	run "$S"
	[ "$status" -eq 2 ]
	for cmd in requirements check verify findings reply checks merge disarm; do
		[[ "$output" == *"shepherd.sh $cmd "* ]] || {
			echo "the usage lacks $cmd"
			return 1
		}
	done
}

@test "an unknown command exits 2 and makes no call to GitHub" {
	usage_error bogus 42
}

@test "requirements: a missing, non-numeric or extra argument exits 2" {
	usage_error requirements
	usage_error requirements abc
	usage_error requirements 11 12
}

@test "check: a missing, non-numeric or extra argument exits 2" {
	usage_error check
	usage_error check abc
	usage_error check 42 43
}

@test "verify: a missing, non-numeric or extra argument exits 2" {
	usage_error verify
	usage_error verify abc
	usage_error verify 42 43
}

@test "findings: a missing or non-numeric PR exits 2" {
	usage_error findings
	usage_error findings abc
}

@test "reply: too few arguments, a bad PR or verdict, or a bad option exit 2" {
	usage_error reply
	usage_error reply 42 PRRT_bot
	usage_error reply abc PRRT_bot rejected --reason r
	usage_error reply 42 PRRT_bot maybe --reason r
	usage_error reply 42 PRRT_bot rejected --bogus
	usage_error reply 42 PRRT_bot rejected --reason
	usage_error reply 42 PRRT_bot accepted --reason r --fix
}

@test "checks: a missing, non-numeric or unknown argument exits 2" {
	usage_error checks
	usage_error checks abc
	usage_error checks 42 --bogus
}

@test "merge: a missing, non-numeric or extra argument exits 2" {
	usage_error merge
	usage_error merge abc
	usage_error merge 42 43
}

@test "disarm: a missing, non-numeric or extra argument exits 2" {
	usage_error disarm
	usage_error disarm abc
	usage_error disarm 11 12
}

# ----------------------------------------------------------- requirements

@test "requirements reads both headings of an issue and skips comments, code and the placeholder" {
	new_case
	cat >"$CASE/issue.txt" <<'ISSUE'
### Done when

<!-- a hint
- [ ] hint in a comment
-->

- [ ] first

```md
- [ ] example in a code block
```

- _No response_

### Acceptance criteria

- [ ] second
ISSUE
	run --separate-stderr "$S" requirements 11
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' '## Requirements' '' '- [ ] R1: first' '- [ ] R2: second')" ]
}

@test "requirements keeps stdout empty when the issue has no items, so a paste stays clean" {
	new_case
	printf '### Done when\n\n_No response_\n' >"$CASE/issue.txt"
	run --separate-stderr "$S" requirements 11
	[ "$status" -eq 1 ]
	[ -z "$output" ]
	[[ "$stderr" == *"Issue #11 has no items"* ]] || false
}

@test "requirements exits 2 when it cannot read the issue" {
	new_case
	GH_FAIL="issue view" run "$S" requirements 11
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read issue #11."* ]] || false
}

# ---------------------------------------------------------- check: PR kind

@test "check exempts a Dependabot PR under each login form of gh" {
	new_case
	cp "$GOOD/dependabot/body.txt" "$GOOD/dependabot/statuses.json" "$GOOD/dependabot/threads.json" "$CASE/"
	for login in app/dependabot 'dependabot[bot]' dependabot; do
		printf '.author = {"login": "%s"}\n' "$login" >"$CASE/pr.json.jq"
		run "$S" check 42
		[ "$status" -eq 0 ] || {
			echo "$login: exit $status"
			return 1
		}
		[ "$output" = "$(printf '%s\n' 'PR #42 is a Dependabot PR. It is exempt.' 'PR #42 passes every shepherd rule.')" ]
	done
}

@test "check does not exempt an author whose login only holds dependabot" {
	new_case
	cp "$GOOD/dependabot/body.txt" "$GOOD/dependabot/statuses.json" "$GOOD/dependabot/threads.json" "$CASE/"
	echo '.author = {"login": "not-dependabot"}' >"$CASE/pr.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'The body has no "Closes #<issue>" line. Add it, or add the label pr:no-issue.' ]
}

@test "check reads Closes, Fixes and Resolves as the closing line, with trailing spaces" {
	new_case
	for word in Closes Fixes Resolves; do
		echo "s/^Closes #11\$/$word #11   /" >"$CASE/body.txt.sed"
		run "$S" check 42
		[ "$status" -eq 0 ] || {
			echo "$word: exit $status"
			return 1
		}
	done
}

@test "check does not read a closing line in a comment or a code block" {
	new_case
	{ printf '<!-- Closes #11 -->\n'; sed 1d "$BASE/body.txt"; } >"$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == *'The body has no "Closes #<issue>" line.'* ]] || false
	{ printf '```\nCloses #11\n```\n'; sed 1d "$BASE/body.txt"; } >"$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == *'The body has no "Closes #<issue>" line.'* ]] || false
}

@test "check follows the first closing line only" {
	new_case
	{ printf 'Closes #7\nCloses #11\n'; sed 1d "$BASE/body.txt"; } >"$CASE/body.txt"
	printf '### What and why\n\nw\n' >"$CASE/issue.txt"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #7 has no items"* ]] || false
}

# ------------------------------------------------------ check: tasks, text

@test "check ignores the tasks in a multi-line HTML comment" {
	new_case
	{ cat "$BASE/body.txt"; printf '\n<!--\n- [ ] a hint\n- [ ] another hint\n-->\n'; } >"$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check wants no evidence for a ticked task outside Requirements and Verify" {
	new_case
	{ cat "$BASE/body.txt"; printf '\n## Notes\n\n- [x] update the docs\n'; } >"$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check names an unticked task by its first 60 characters" {
	new_case
	ten=abcdefghij
	{ cat "$BASE/body.txt"; printf '\n## Notes\n\n- [ ] %s\n' "$ten$ten$ten$ten$ten$ten$ten"; } >"$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = "\"$ten$ten$ten$ten$ten$ten\": not ticked. Finish the task, then tick it, or remove it." ]
}

@test "check reads tab indents like four spaces" {
	new_case
	tab=$(printf '\t')
	sed -e "s/^    - /$tab$tab- /" -e "s/^  - /$tab- /" "$BASE/body.txt" >"$CASE/body.txt"
	grep -q "^$tab$tab- evidence" "$CASE/body.txt"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check wants an evidence line below a ticked Verify item" {
	new_case
	echo '/`mise run check` -> ok$/d' >"$CASE/body.txt.sed"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'V1: a ticked leaf needs an "evidence:" line below it.' ]
}

@test "check wants the evidence of a sub-task on the sub-task, not on its parent" {
	new_case
	echo '/evidence: scripts\/check.sh$/d' >"$CASE/body.txt.sed"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'R1.1: a ticked leaf needs an "evidence:" line below it.' ]
}

# ---------------------------------------------------------- check: evidence

@test "check accepts a path, a dot path, a folder, an https URL and a command with its result" {
	r2_evidence '  - evidence: `scripts/check.sh`' '  - evidence: ./scripts/check.sh' \
		'  - evidence: tests/' '  - evidence: .github/workflows' \
		'  - evidence: https://example.com/run/1' '  - evidence: `make test` -> 12 ok'
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check judges each evidence line of an item on its own" {
	r2_evidence '  - evidence: tests/' '  - evidence: `scripts/chec`' \
		'  - evidence: http://example.com/run/1' '  - evidence: `deadbeef`'
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' \
		'R2: evidence "`scripts/chec`" is not a path that this PR changes. Name a path from the PR diff.' \
		'R2: evidence "http://example.com/run/1" is not a path that this PR changes. Name a path from the PR diff.' \
		'R2: evidence "`deadbeef`" is a commit SHA. A rebase changes it. Name a changed path, an https URL or a command with its result.')" ]
}

# --------------------------------------------------------- check: reviews

@test "check passes a PR without review threads and reviews" {
	new_case
	echo '{"reviewThreads": {"nodes": []}, "reviews": {"nodes": []}}' >"$CASE/threads.json"
	echo '[]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check lets a bot reject its finding alone, also when gh types the bot as a user" {
	new_case
	cat >"$CASE/threads.json.jq" <<'JQ'
.reviewThreads.nodes[1].comments.nodes[0].author = {"login": "helper[bot]", "__typename": "User"}
| .reviewThreads.nodes[1].comments.nodes[1].body = "triage: rejected\nreason: false alarm"
JQ
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check treats the author of a deleted account as a human" {
	new_case
	cat >"$CASE/threads.json.jq" <<'JQ'
.reviewThreads.nodes[1].comments.nodes[0].author = null
| .reviewThreads.nodes[1].comments.nodes[1].body = "triage: rejected\nreason: false alarm"
JQ
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'Thread PRRT_human (ghost): a rejection of a human finding needs "confirmed-by-user: yes". Ask the user first.' ]
}

@test "check does not read the finding itself as its triage" {
	new_case
	cat >"$CASE/threads.json.jq" <<'JQ'
.reviewThreads.nodes[0].comments.nodes = [{"author": {"login": "codex[bot]", "__typename": "Bot"}, "body": "triage: accepted\nfix: scripts/check.sh"}]
JQ
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == "Thread PRRT_bot (codex[bot]): not triaged."* ]] || false
}

@test "check does not read a triage line with an unknown verdict" {
	new_case
	echo '.reviewThreads.nodes[0].comments.nodes[1].body = "triage: maybe\nreason: unsure"' >"$CASE/threads.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == "Thread PRRT_bot (codex[bot]): not triaged."* ]] || false
}

@test "check reads triage text with CRLF line ends, in a thread and in a comment" {
	new_case
	echo '.reviewThreads.nodes[0].comments.nodes[1].body = "triage: accepted\r\nreason: real\r\nfix: scripts/check.sh\r\n"' \
		>"$CASE/threads.json.jq"
	jq -n '[{id: 9001, body: "review: 501\r\ntriage: accepted\r\nreason: a gap\r\nfix: tests/check.bats\r\n"}]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check applies the fix rule to the triage of a review body" {
	new_case
	jq -n '[{id: 9001, body: "review: 501\ntriage: accepted\nreason: a gap"}]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'Review 501 (codex[bot]): the accepted triage has no "fix:" line. Fix the finding, then reply again with --fix.' ]
}

@test "check ignores a triage comment that names another review" {
	new_case
	jq -n '[{id: 9001, body: "review: 5011\ntriage: accepted\nreason: a gap\nfix: tests/check.bats"}]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == "Review 501 (codex[bot]): the review body is not triaged."* ]] || false
}

@test "check keeps a changes-requested review open after its author comments again or another reviewer approves" {
	new_case
	cat >"$CASE/threads.json.jq" <<'JQ'
.reviews.nodes = [
  {"databaseId": 503, "state": "CHANGES_REQUESTED", "body": "", "author": {"login": "bob", "__typename": "User"}},
  {"databaseId": 505, "state": "COMMENTED", "body": "", "author": {"login": "bob", "__typename": "User"}},
  {"databaseId": 506, "state": "PENDING", "body": "", "author": {"login": "bob", "__typename": "User"}},
  {"databaseId": 507, "state": "APPROVED", "body": "", "author": {"login": "alice", "__typename": "User"}}]
JQ
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'Review 503 (bob): changes requested. Address the findings, then ask bob to approve or dismiss the review.' ]
}

@test "check exits 2 when the list of reviews has a next page" {
	new_case
	jq '.reviews.pageInfo = {hasNextPage: true}' "$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"more than 100 review threads, reviews or thread comments"* ]] || false
}

@test "check reads the review threads of a PR that needs no issue" {
	new_case
	cp "$GOOD/no-issue-label/body.txt" "$GOOD/no-issue-label/pr.json.jq" "$GOOD/no-issue-label/statuses.json" "$CASE/"
	run "$S" check 42
	[ "$status" -eq 0 ]
	echo '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' >"$CASE/threads.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Thread PRRT_bot (codex[bot]): not triaged."* ]] || false
}

# -------------------------------------------------------- check: the trace

@test "check ignores the statuses of other contexts" {
	new_case
	echo '[{"context": "ci", "state": "success", "description": "ok", "target_url": "https://example.com"}]' >"$CASE/statuses.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = "Trace: no pr-shepherd/trace status on 01234567. Run: shepherd.sh verify 42" ]
}

@test "check reads the newest trace status first, and a pending trace is not a pass" {
	new_case
	echo '.[0].state = "pending"' >"$CASE/statuses.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == "Trace: the pr-shepherd/trace status is pending."* ]] || false
	# An older success below a newer failure does not count.
	jq '[.[1], .[0]]' "$BASE/statuses.json" >"$CASE/statuses.json"
	rm "$CASE/statuses.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == "Trace: the pr-shepherd/trace status is failure."* ]] || false
}

# ------------------------------------------------------ check: failed calls

@test "check exits 2 and says which read failed" {
	new_case
	for pair in "pr view|Cannot read PR #42." \
		"pulls/42/files|Cannot read the files of PR #42." \
		"issue view|Cannot read issue #11." \
		"commits/|Cannot read the statuses of 0123456789abcdef0123456789abcdef01234567." \
		"reviewThreads|Cannot read the reviews of PR #42." \
		"issues/42/comments?per_page|Cannot read the comments of PR #42."; do
		GH_FAIL=${pair%%|*} run "$S" check 42
		[ "$status" -eq 2 ] || {
			echo "${pair%%|*}: exit $status"
			return 1
		}
		[[ "$output" == *"${pair#*|}"* ]] || {
			echo "${pair%%|*}: output '$output'"
			return 1
		}
	done
}
