#!/usr/bin/env bats

# The steps from a PR that passes check to a PR that merges. verify writes
# the trace that check demands. findings and reply triage the reviews.
# checks and merge guard the merge. disarm takes the merge back when the
# issue changes. carry keeps the trace over a push. The usage errors and check are in shepherd.bats.

# run --separate-stderr needs bats 1.5 or later.
bats_require_minimum_version 1.5.0

# The fake gh of helpers/gh serves the base PR fixture and logs each write.
# The shared fake decisionkit answers true, unless the text holds the word
# WRONG. DK_P sets another probability, and DK_FAIL=1 makes it fail. The
# real decide.sh runs between them, so the tests also cover the questions
# file.
ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	# The script runs from a copy of the skill and of the decisionkit skill
	# next to it, so it cannot change the repository.
	SKILL_DIR="$(skill_copy pr-shepherd decisionkit)/pr-shepherd"
	S="$SKILL_DIR/scripts/shepherd.sh"
	export SHEPHERD=$S
	export BASE="$SKILL_DIR/tests/fixtures/prs/base"
	export SHEPHERD_LABELS="$BASE/labels.yml"
	GOOD="$SKILL_DIR/tests/fixtures/prs/good"
	export CASE="$BATS_TEST_TMPDIR/case"
	mkdir -p "$CASE" "$BATS_TEST_TMPDIR/bin"
	export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
	ln -s "$SKILL_DIR/tests/helpers/gh" "$BATS_TEST_TMPDIR/bin/gh"
	export DK_P=0.95
	fake_decisionkit
	dk_responder <<'EOF'
[[ "$text" == *WRONG* ]] && DK_P=0.1
EOF
}

@test "verify asks both questions for each R item and writes a success trace" {
	echo '7001 completed' >"$CASE/runs.txt"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[ "$(grep -c '^Issue item:$' "$FAKE_DIR/decisionkit.text")" -eq 3 ]
	[ "$(grep -c '^Claim:$' "$FAKE_DIR/decisionkit.text")" -eq 3 ]
	# R1 has sub-tasks, R2 has none.
	grep -qx -- '- add the tick rule to the check' "$FAKE_DIR/decisionkit.text"
	grep -qx '(none)' "$FAKE_DIR/decisionkit.text"
	[[ "$output" == *"Requirement check: passed, all 3 pass"* ]] || false
	[[ "$output" == *"Passed: R1 R2 R3"* ]] || false
	# The base PR has no trace comment, so verify writes a new one.
	grep -q '^api repos/{owner}/{repo}/issues/42/comments -f body=<!-- pr-shepherd-trace:v1 -->' "$GH_LOG"
	grep -q '^api repos/{owner}/{repo}/statuses/0123456789abcdef0123456789abcdef01234567 -f state=success -f context=pr-shepherd/trace -f description=req=[0-9a-f]\{8\} issue=[0-9a-f]\{8\} review= -f target_url=https://' "$GH_LOG"
	grep -qx 'run rerun 7001' "$GH_LOG"
}

@test "the hashes that verify writes make check see a fresh trace" {
	run "$S" verify 42
	[ "$status" -eq 0 ]
	desc=$(sed -n 's/.*-f description=\(req=[0-9a-f]* issue=[0-9a-f]* review=[0-9,]*\) .*/\1/p' "$GH_LOG")
	[ -n "$desc" ]
	jq --arg d "$desc" '.[0].description = $d' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "verify writes a failure trace when an answer is false" {
	sed 's/R1.1: add the tick rule to the check/R1.1: add a WRONG rule/' "$BASE/body.txt" >"$CASE/body.txt"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Requirement check: failed, 1 of 3 failed"* ]] || false
	[[ "$output" == *"Failed:"*"R1: the check fails on an unticked task"*"Plan matches issue: ❌ fail, Proof of done: ❌ fail"*"a part of the item has no sub-task"* ]] || false
	grep -q -- '-f state=failure' "$GH_LOG"
}

@test "verify updates the trace comment that exists" {
	jq '. + [{"id": 9002, "html_url": "https://x/9002", "body": "<!-- pr-shepherd-trace:v1 -->\nold"}]' \
		"$BASE/comments.json" >"$CASE/comments.json"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	grep -q '^api -X PATCH repos/{owner}/{repo}/issues/comments/9002 -f body=' "$GH_LOG"
	run ! grep -q 'issues/42/comments -f body' "$GH_LOG"
}

@test "verify writes no trace when the R items do not match the issue" {
	sed 's/R2: the check fails on/R2: the check warns on/' "$BASE/body.txt" >"$CASE/body.txt"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"R2: the text differs from item 2 of issue #11."* ]] || false
	[ ! -f "$FAKE_DIR/decisionkit.text" ]
	run ! grep -q statuses "$GH_LOG" 2>/dev/null
}

@test "verify skips an exempt PR" {
	echo '.labels = [{"name": "pr:no-issue"}]' >"$CASE/pr.json.jq"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"exempt"* ]] || false
	[ ! -f "$GH_LOG" ]
}

@test "findings lists each untriaged finding with the advice of decisionkit" {
	jq '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' "$BASE/threads.json" >"$CASE/threads.json"
	echo '[]' >"$CASE/comments.json"
	run "$S" findings 42
	[ "$status" -eq 0 ]
	[ "$(grep -c . <<<"$output")" -eq 2 ]
	line=$(head -n 1 <<<"$output")
	jq -e '.target == "PRRT_bot" and .kind == "bot" and .valid.answer == "true" and .severity.answer == "low"' <<<"$line"
	jq -e '.target == "501" and .type == "review"' <<<"$(sed -n 2p <<<"$output")"
	run "$S" findings 42 --no-advice
	jq -e 'has("valid") | not' <<<"$(head -n 1 <<<"$output")"
}

@test "reply refuses to reject a human finding without the user" {
	run "$S" reply 42 PRRT_human rejected --reason "the name is right"
	[ "$status" -eq 1 ]
	[[ "$output" == *"Ask the user"* ]] || false
	[ ! -f "$GH_LOG" ]
	run "$S" reply 42 PRRT_human rejected --reason "the name is right" --confirmed-by-user
	[ "$status" -eq 0 ]
	grep -q 'addPullRequestReviewThreadReply' "$GH_LOG"
	grep -q 'confirmed-by-user: yes' "$GH_LOG"
	grep -q 'resolveReviewThread' "$GH_LOG"
}

@test "reply rejects a bot finding alone, and needs a fix that is no SHA to accept" {
	run "$S" reply 42 PRRT_bot rejected --reason "false alarm"
	[ "$status" -eq 0 ]
	run "$S" reply 42 PRRT_bot accepted --reason "real"
	[ "$status" -eq 2 ]
	run "$S" reply 42 PRRT_bot accepted --reason "real" --fix 5bcce5c
	[ "$status" -eq 2 ]
	[[ "$output" == *"commit SHA"* ]] || false
	run "$S" reply 42 PRRT_none accepted --reason "real" --fix scripts/check.sh
	[ "$status" -eq 2 ]
}

@test "reply triages a review body with a PR comment" {
	run "$S" reply 42 501 accepted --reason "a real gap" --fix tests/check.bats
	[ "$status" -eq 0 ]
	grep -q '^api repos/{owner}/{repo}/issues/42/comments -f body=review: 501' "$GH_LOG"
	grep -q 'triage: accepted' "$GH_LOG"
	grep -q 'fix: tests/check.bats' "$GH_LOG"
}

@test "merge refuses while the ruleset does not require the pr-shepherd check" {
	echo '[{"type": "pull_request", "parameters": {}}]' >"$CASE/rules.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"do not require the pr-shepherd check"* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

@test "merge refuses a PR that fails check" {
	echo '[]' >"$CASE/statuses.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Fix the problems above before merge."* ]] || false
}

@test "merge turns on auto-merge with squash when every rule holds" {
	run "$S" merge 42
	[ "$status" -eq 0 ]
	grep -qx 'pr merge 42 --auto --squash' "$GH_LOG"
}

@test "disarm turns off auto-merge on each open PR that closes the issue" {
	printf '42\n43\n' >"$CASE/closing.txt"
	run "$S" disarm 11
	[ "$status" -eq 0 ]
	grep -qx 'pr merge 42 --disable-auto' "$GH_LOG"
	grep -qx 'pr merge 43 --disable-auto' "$GH_LOG"
	rm "$CASE/closing.txt"
	run "$S" disarm 11
	[ "$status" -eq 0 ]
	[[ "$output" == *"No open PR with auto-merge closes issue #11."* ]] || false
}

@test "checks passes when every other check passed or was skipped, and leaves out its own" {
	run "$S" checks 42
	[ "$status" -eq 0 ]
	[ "$output" = "Every other check of PR #42 passed." ]
}

@test "checks names each failed, pending or cancelled check and how to address it" {
	jq '. + [
		{bucket: "fail", link: "https://github.com/acme/app/actions/runs/702/job/4", name: "lint", workflow: "ci"},
		{bucket: "fail", link: "https://ci.example.com/build/9", name: "external", workflow: ""},
		{bucket: "pending", link: "https://github.com/acme/app/actions/runs/703/job/5", name: "test", workflow: "ci"},
		{bucket: "cancel", link: "https://github.com/acme/app/actions/runs/704/job/6", name: "e2e", workflow: "ci"}]' \
		"$BASE/checks.json" >"$CASE/checks.json"
	run "$S" checks 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' \
		'Check ci/lint: failed. Read: gh run view 702 --log-failed. Fix the cause, push, then run a new pass.' \
		'Check external: failed. Read https://ci.example.com/build/9. Fix the cause, push, then run a new pass.' \
		'Check ci/test: still running. Run: shepherd.sh checks 42 --watch' \
		'Check ci/e2e: cancelled. Re-run it: gh run rerun 704.')" ]
}

@test "checks --watch waits for the checks first" {
	run "$S" checks 42 --watch
	[ "$status" -eq 0 ]
	grep -qx 'pr checks 42 --watch' "$GH_LOG"
}

@test "merge refuses while another check fails" {
	jq '. + [{bucket: "fail", link: "https://github.com/acme/app/actions/runs/702/job/4", name: "lint", workflow: "ci"}]' \
		"$BASE/checks.json" >"$CASE/checks.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Check ci/lint: failed."* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

# ---------------------------------------------------------------- helpers

# Print the body of the first write in the gh log, without the flags that
# follow it. A body can span lines.
logged_body() {
	awk '
		!inside && /-f body=/ { inside = 1; sub(/^.*-f body=/, "") }
		inside {
			if ((i = index($0, " -f query=")) > 0) { print substr($0, 1, i - 1); exit }
			if ($0 ~ /^(api|pr|run) /) exit
			print
		}' "$GH_LOG" | sed -E 's/ (--silent|--jq \.html_url)$//'
}

# ----------------------------------------------------------------- verify

@test "verify exempts a Dependabot PR" {
	echo '.author = {"login": "dependabot[bot]"}' >"$CASE/pr.json.jq"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 is exempt. It needs no trace." ]
	[ ! -f "$GH_LOG" ]
	[ ! -f "$FAKE_DIR/decisionkit.text" ]
}

@test "verify exits 1 and writes nothing when the body has no closing line" {
	echo '/^Closes #11$/d' >"$CASE/body.txt.sed"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *'The body has no "Closes #<issue>" line.'* ]] || false
	[ ! -f "$GH_LOG" ]
	[ ! -f "$FAKE_DIR/decisionkit.text" ]
}

@test "verify exits 1 and writes no trace while R or V items are wrong" {
	echo '/V1 \(R1, R3\)/,$d' >"$CASE/body.txt.sed"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Verify: the PR has no V item."* ]] || false
	[[ "$output" == *"Fix the R and V items first. verify wrote no trace."* ]] || false
	[ ! -f "$FAKE_DIR/decisionkit.text" ]
	[ ! -f "$GH_LOG" ]
}

@test "verify exits 2 and says which read failed" {
	for pair in "pr view|Cannot read PR #42." \
		"issue view|Cannot read issue #11." \
		"issues/42/comments?per_page|Cannot read the comments of PR #42."; do
		GH_FAIL=${pair%%|*} run "$S" verify 42
		[ "$status" -eq 2 ] || {
			echo "${pair%%|*}: exit $status"
			return 1
		}
		[[ "$output" == *"${pair#*|}"* ]] || {
			echo "${pair%%|*}: output '$output'"
			return 1
		}
	done
	run ! grep -q 'statuses' "$GH_LOG"
}

@test "verify exits 2 and writes no trace when decisionkit fails" {
	DK_FAIL=1 run "$S" verify 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed. Run: decisionkit status"* ]] || false
	run ! grep -q 'statuses\|comments -f body' "$GH_LOG" 2>/dev/null
}

@test "verify passes an uncertain true answer and marks the row" {
	DK_P=0.6 run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"Requirement check: passed, 3 of 3 need a review"* ]] || false
	[[ "$output" == *"Needs review:"*"Plan matches issue: ⚠️ review, Proof of done: ⚠️ review"* ]] || false
	[[ "$output" == *'Plan matches issue: decisionkit cannot confirm that the sub-tasks do the whole item. Proof of done: decisionkit cannot confirm that the evidence shows the item works. No justification yet. Add the line `R1: <reason>` to the Notes of the PR.'* ]] || false
	[[ "$output" != *"Failed:"* && "$output" != *"Passed:"* ]] || false
	grep -q -- '-f state=success' "$GH_LOG"
	body=$(logged_body)
	grep -qxF 'Before the merge, each row under "Needs review" needs a line `R<n>: <reason>` in the Notes of the PR, and a person reads each row. The "Why" column shows the Notes at the time of this check.' <<<"$body"
	grep -qxF '| R1: the check fails on an unticked task | ⚠️ review | ⚠️ review | Plan matches issue: decisionkit cannot confirm that the sub-tasks do the whole item. Proof of done: decisionkit cannot confirm that the evidence shows the item works. No justification yet. Add the line `R1: <reason>` to the Notes of the PR. |' <<<"$body"
}

@test "verify lists the review rows in the trace status, so check can ask for their justification" {
	DK_P=0.6 run "$S" verify 42
	[ "$status" -eq 0 ]
	grep -q -- '-f description=req=[0-9a-f]\{8\} issue=[0-9a-f]\{8\} review=1,2,3 -f target_url=' "$GH_LOG"
	desc=$(sed -n 's/.*-f description=\(req=[0-9a-f]* issue=[0-9a-f]* review=[0-9,]*\) .*/\1/p' "$GH_LOG")
	jq --arg d "$desc" '.[0].description = $d' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[[ "$output" == *'R2: the trace marks the row "review", and "## Notes" has no line "R2: <reason>".'* ]] || false
}

@test "verify exits 2 and writes no trace when the review rows do not fit in a commit status" {
	# 39 review rows make a description of 141 characters.
	{
		printf '### Done when\n\n'
		for i in $(seq 39); do printf -- '- item %d\n' "$i"; done
	} >"$CASE/issue.txt"
	{
		printf 'Closes #11\n\n## Requirements\n\n'
		for i in $(seq 39); do printf -- '- [x] R%d: item %d\n  - evidence: tests/\n' "$i" "$i"; done
		printf '\n## Verify\n\n- [x] V1 (R1): ok\n  - evidence: tests/\n'
	} >"$CASE/body.txt"
	DK_P=0.6 run "$S" verify 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"The trace has more review rows than the 140 characters of a commit status description can list."* ]] || false
	run ! grep -q 'statuses\|comments -f body' "$GH_LOG" 2>/dev/null
}

@test "verify fails an R item without evidence and does not ask the evidence question for it" {
	echo '/evidence: tests\/$/d' >"$CASE/body.txt.sed"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"R2: the check fails on a missing evidence line"*"Plan matches issue: ✅ pass, Proof of done: ❌ fail"*"Proof of done: the item has no evidence line."* ]] || false
	[[ "$output" != *"justification"* ]] || false
	logged_body | grep -qx '| R2 | 95 % | — |'
	[ "$(grep -c '^Claim:$' "$FAKE_DIR/decisionkit.text")" -eq 2 ]
	grep -q -- '-f state=failure' "$GH_LOG"
}

@test "verify gives the evidence of the sub-tasks to the evidence question of their item" {
	run "$S" verify 42
	[ "$status" -eq 0 ]
	# The claim of R1 holds its sub-tasks, and the evidence below them.
	awk '/^Claim:$/ { n++ } n == 1' "$FAKE_DIR/decisionkit.text" | grep -qx 'R1.1: add the tick rule to the check'
	awk '/^Claim:$/ { n++ } n == 1' "$FAKE_DIR/decisionkit.text" | grep -qx 'scripts/check.sh'
	awk '/^Claim:$/ { n++ } n == 1' "$FAKE_DIR/decisionkit.text" | grep -qx '`bats tests` -> 12 ok'
}

@test "verify writes a trace comment with the summary, the legend, the groups and the technical details" {
	run "$S" verify 42
	[ "$status" -eq 0 ]
	body=$(logged_body)
	[ "$(head -n 1 <<<"$body")" = '<!-- pr-shepherd-trace:v1 -->' ]
	grep -qx '## Requirement check: passed, all 3 pass' <<<"$body"
	grep -qx 'This check does not block the merge.' <<<"$body"
	grep -qx -- '- \*\*Plan matches issue:\*\* the sub-tasks of the PR do the whole issue item.' <<<"$body"
	grep -qx -- '- \*\*Proof of done:\*\* the evidence lines show that the item works.' <<<"$body"
	grep -c '^### ' <<<"$body" | grep -qx 0
	grep -qx '<summary>✅ Passed: 3 of 3</summary>' <<<"$body"
	grep -qx '| R3: CI runs the check | ✅ pass | ✅ pass |' <<<"$body"
	grep -qx 'decisionkit scores each check with the probability that it is true. A check fails below 43 %. From 80 % on, it passes without a review.' <<<"$body"
	grep -qx '| R3 | 95 % | 95 % |' <<<"$body"
	grep -qE '^Head commit `01234567`\. Requirements hash `[0-9a-f]{8}`\. Issue #11 hash `[0-9a-f]{8}`\. ' <<<"$body"
	grep -qxF 'Run the check again: `.agents/skills/pr-shepherd/scripts/shepherd.sh verify 42`' <<<"$body"
	[[ "$output" == *"Trace: success on 01234567. https://github.com/acme/app/pull/42#issuecomment-9002"* ]] || false
}

@test "verify writes the trace comment of the golden file for the scores of PR #20" {
	# The case freezes the body of PR #20, issue #18 and the 28 answers of
	# its last trace, in the order that verify asks: carryover, then
	# evidence, for each R item.
	export CASE="$SKILL_DIR/tests/fixtures/trace/pr20"
	export DK_SCORES="$CASE/scores.txt" DK_COUNT="$BATS_TEST_TMPDIR/dk.count"
	dk_responder <<'EOF'
n=$(($(cat "$DK_COUNT" 2>/dev/null || echo 0) + 1))
echo "$n" >"$DK_COUNT"
DK_P=$(sed -n "${n}p" "$DK_SCORES")
EOF
	run "$S" verify 20
	[ "$status" -eq 0 ]
	[ "$(cat "$DK_COUNT")" -eq 28 ]
	diff -u "$CASE/comment.txt" <(logged_body)
}

@test "verify tells the author how to fix a failure trace" {
	sed 's/R1.1: add the tick rule to the check/R1.1: add a WRONG rule/' "$BASE/body.txt" >"$CASE/body.txt"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	body=$(logged_body)
	grep -qx '## Requirement check: failed, 1 of 3 failed' <<<"$body"
	grep -qx 'This check blocks the merge until each failed row passes.' <<<"$body"
	grep -qx '### ❌ Failed' <<<"$body"
	grep -qxF '| R1: the check fails on an unticked task | ❌ fail | ❌ fail | Plan matches issue: a part of the item has no sub-task. Proof of done: the evidence does not show that the item works. |' <<<"$body"
	[[ "$output" == *"Trace: failure on 01234567."* ]] || false
}

@test "verify links a review row to the Notes only when a Notes line starts with its R item" {
	# "- R1:" justifies R1. A bare R2 and a sub-task line R3.1 justify nothing.
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Notes' '' '- R1: each sub-task has a test.' '- R2 holds, see the test.' '- R3.1: the run is green.' >"$CASE/body.txt"
	DK_P=0.6 run "$S" verify 42
	[ "$status" -eq 0 ]
	body=$(logged_body)
	grep -qF '| R1: the check fails on an unticked task | ⚠️ review | ⚠️ review | Plan matches issue: decisionkit cannot confirm that the sub-tasks do the whole item. Proof of done: decisionkit cannot confirm that the evidence shows the item works. [The author explains it in the Notes of the PR](https://github.com/acme/app/pull/42). |' <<<"$body"
	grep -qF '| R2: the check fails on a missing evidence line | ⚠️ review | ⚠️ review | Plan matches issue: decisionkit cannot confirm that the sub-tasks do the whole item. Proof of done: decisionkit cannot confirm that the evidence shows the item works. No justification yet. Add the line `R2: <reason>` to the Notes of the PR. |' <<<"$body"
	grep -q '^| R3: .*No justification yet\. Add the line `R3: <reason>` to the Notes of the PR\. |$' <<<"$body"
	[[ "$output" == *"The author explains it in the Notes of the PR."* ]] || false
}

@test "short_text cuts a long requirement at a word, outside a code span, and escapes a pipe" {
	source "$S"
	[ "$(short_text <<<'short | text')" = 'short \| text' ]
	long='The README, AGENTS.md files, the skills and the workflow comments describe the new behaviour.'
	[ "$(short_text <<<"$long")" = 'The README, AGENTS.md files, the skills and the workflow comments describe the…' ]
	code='A change in a shared input or the label `ci:full` runs every suite. `.github/labels.yml` defines it.'
	[ "$(short_text <<<"$code")" = 'A change in a shared input or the label `ci:full` runs every suite.…' ]
}

@test "verify asks for a new run of the pr-shepherd workflow on the head" {
	echo '7001 completed' >"$CASE/runs.txt"
	run "$S" verify 42
	grep -qxF 'run list --workflow pr-shepherd.yml --commit 0123456789abcdef0123456789abcdef01234567 --limit 1 --json databaseId,status --jq .[0] | "\(.databaseId) \(.status)"' "$GH_LOG"
	[[ "$output" == *"Re-ran run 7001."* ]] || false
	run ! grep -q '^run watch' "$GH_LOG"
}

@test "verify waits for a run that is still going before it re-runs it" {
	echo '7002 in_progress' >"$CASE/runs.txt"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"Waiting for run 7002 to end."* ]] || false
	grep -qx 'run watch 7002' "$GH_LOG"
	grep -qx 'run rerun 7002' "$GH_LOG"
}

@test "verify says so when no run exists yet, and does not fail" {
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"No pr-shepherd run on 01234567 yet. The next run reads the trace."* ]] || false
	echo 'null null' >"$CASE/runs.txt"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"No pr-shepherd run on 01234567 yet."* ]] || false
	run ! grep -q '^run rerun' "$GH_LOG"
}

@test "verify points to the Actions tab when the re-run fails, and does not fail" {
	echo '7001 completed' >"$CASE/runs.txt"
	GH_FAIL="run rerun" run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"Could not re-run run 7001. Re-run it in the Actions tab."* ]] || false
}

@test "verify exits 2 when a write fails, and says which" {
	GH_FAIL="issues/42/comments -f body" run "$S" verify 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot write the trace comment."* ]] || false
	run ! grep -q -- '-f state=' "$GH_LOG"
	jq '. + [{"id": 9002, "html_url": "https://x/9002", "body": "<!-- pr-shepherd-trace:v1 -->\nold"}]' \
		"$BASE/comments.json" >"$CASE/comments.json"
	GH_FAIL="-X PATCH" run "$S" verify 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot update the trace comment 9002."* ]] || false
	GH_FAIL="-f state=" run "$S" verify 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot write the pr-shepherd/trace status."* ]] || false
}

# --------------------------------------------------------------- findings

@test "findings prints nothing when every finding is triaged" {
	run "$S" findings 42
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ ! -f "$FAKE_DIR/decisionkit.text" ]
}

@test "findings reports the thread, the author and the place of each finding" {
	cat >"$CASE/threads.json.jq" <<'JQ'
.reviewThreads.nodes[1].comments.nodes |= .[0:1]
| .reviewThreads.nodes[1].comments.nodes[0].author = null
JQ
	run "$S" findings 42 --no-advice
	[ "$status" -eq 0 ]
	jq -e '.type == "thread" and .target == "PRRT_human" and .author == "ghost" and .kind == "human"
		and .path == "tests/check.bats" and .line == 9 and .text == "Rename this test?"' <<<"$output"
}

@test "findings gives decisionkit the place and the text of each finding" {
	jq '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' "$BASE/threads.json" >"$CASE/threads.json"
	echo '[]' >"$CASE/comments.json"
	run "$S" findings 42
	[ "$status" -eq 0 ]
	grep -qx 'Finding on scripts/check.sh:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'The loop skips the last item.' "$FAKE_DIR/decisionkit.text"
	grep -qx 'Finding on the PR:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'Overall: add a test for the empty body.' "$FAKE_DIR/decisionkit.text"
	# Two questions for each of the two findings.
	[ "$(grep -c '^---$' "$FAKE_DIR/decisionkit.text")" -eq 4 ]
}

@test "findings exits 2 when decisionkit fails or a read fails" {
	jq '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' "$BASE/threads.json" >"$CASE/threads.json"
	DK_FAIL=1 run "$S" findings 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed. Run: decisionkit status"* ]] || false
	GH_FAIL="reviewThreads" run "$S" findings 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the reviews of PR #42."* ]] || false
	GH_FAIL="issues/42/comments?per_page" run "$S" findings 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the comments of PR #42."* ]] || false
}

# ------------------------------------------------------------------ reply

@test "reply writes the triage on the thread, resolves it and says so" {
	run "$S" reply 42 PRRT_bot accepted --reason "real off-by-one" --fix scripts/check.sh
	[ "$status" -eq 0 ]
	[ "$output" = "Triaged thread PRRT_bot as accepted, and resolved it." ]
	[ "$(logged_body)" = "$(printf '%s\n' 'triage: accepted' 'reason: real off-by-one' 'fix: scripts/check.sh')" ]
	grep -q '^api graphql -f id=PRRT_bot -f body=triage: accepted' "$GH_LOG"
	# The reply comes first, then the resolve.
	[ "$(grep -n 'addPullRequestReviewThreadReply' "$GH_LOG" | cut -d : -f 1)" -lt "$(grep -n 'resolveReviewThread' "$GH_LOG" | cut -d : -f 1)" ]
}

@test "reply lets a human finding be accepted without the user" {
	run "$S" reply 42 PRRT_human accepted --reason "good point" --fix tests/check.bats
	[ "$status" -eq 0 ]
	run ! grep -q 'confirmed-by-user' "$GH_LOG"
}

@test "reply asks the user before it rejects a human review, and then records the user" {
	run "$S" reply 42 503 rejected --reason "out of scope"
	[ "$status" -eq 1 ]
	[[ "$output" == *"A human wrote this finding. Ask the user to confirm the rejection"* ]] || false
	[ ! -f "$GH_LOG" ]
	run "$S" reply 42 503 rejected --reason "out of scope" --confirmed-by-user
	[ "$status" -eq 0 ]
	[ "$output" = "Triaged review 503 as rejected." ]
	[ "$(logged_body)" = "$(printf '%s\n' 'review: 503' 'triage: rejected' 'reason: out of scope' 'confirmed-by-user: yes')" ]
}

@test "reply folds a reason of several lines into one line" {
	run "$S" reply 42 PRRT_bot rejected --reason $'a false\n  alarm,   truly\n'
	[ "$status" -eq 0 ]
	[ "$(logged_body)" = "$(printf '%s\n' 'triage: rejected' 'reason: a false alarm, truly')" ]
}

@test "reply needs a reason, and a fix for an accepted finding" {
	run "$S" reply 42 PRRT_bot rejected
	[ "$status" -eq 2 ]
	[[ "$output" == *"Give a reason with --reason."* ]] || false
	run "$S" reply 42 PRRT_bot rejected --reason "  "
	[ "$status" -eq 2 ]
	run "$S" reply 42 PRRT_bot accepted --reason "real"
	[ "$status" -eq 2 ]
	[[ "$output" == *"An accepted finding needs --fix"* ]] || false
	run "$S" reply 42 PRRT_bot accepted --reason "real" --fix deadbeef
	[ "$status" -eq 2 ]
	[[ "$output" == *"--fix names a commit SHA."* ]] || false
	[ ! -f "$GH_LOG" ]
}

@test "reply exits 2 when the target is no thread and no review of the PR" {
	run "$S" reply 42 PRRT_none rejected --reason r
	[ "$status" -eq 2 ]
	[ "$output" = "PR #42 has no review thread or review PRRT_none." ]
	run "$S" reply 42 999 rejected --reason r
	[ "$status" -eq 2 ]
	[ "$output" = "PR #42 has no review thread or review 999." ]
	[ ! -f "$GH_LOG" ]
}

@test "reply exits 2 and says which call failed" {
	GH_FAIL="reviewThreads" run "$S" reply 42 PRRT_bot rejected --reason r
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the reviews of PR #42."* ]] || false
	GH_FAIL="issues/42/comments -f body" run "$S" reply 42 501 rejected --reason r
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot write the triage comment."* ]] || false
	GH_FAIL="addPullRequestReviewThreadReply" run "$S" reply 42 PRRT_bot rejected --reason r
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot reply to thread PRRT_bot."* ]] || false
	run ! grep -q 'resolveReviewThread' "$GH_LOG"
	GH_FAIL="resolveReviewThread" run "$S" reply 42 PRRT_bot rejected --reason r
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot resolve thread PRRT_bot."* ]] || false
}

@test "check reads back the triage that reply writes on a thread" {
	echo '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' >"$CASE/threads.json.jq"
	run "$S" check 42
	[ "$status" -eq 1 ]
	run "$S" reply 42 PRRT_bot accepted --reason "real off-by-one" --fix scripts/check.sh
	[ "$status" -eq 0 ]
	jq --arg b "$(logged_body)" '.reviewThreads.nodes[0].comments.nodes[1] = {"author": {"login": "alice", "__typename": "User"}, "body": $b}' \
		"$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "check reads back the triage that reply writes on a review body" {
	echo '[]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	run "$S" reply 42 501 accepted --reason "a real gap" --fix tests/check.bats
	[ "$status" -eq 0 ]
	jq -n --arg b "$(logged_body)" '[{id: 9001, body: $b}]' >"$CASE/comments.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

# ----------------------------------------------------------------- checks

@test "checks exits 2 when it cannot read the checks" {
	GH_FAIL="pr checks" run "$S" checks 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the checks of PR #42."* ]] || false
}

@test "checks reads the list although gh exits non-zero while a check fails or runs" {
	jq '. + [{bucket: "fail", link: "https://github.com/acme/app/actions/runs/702/job/4", name: "lint", workflow: "ci"}]' \
		"$BASE/checks.json" >"$CASE/checks.json"
	for code in 1 8; do
		GH_CHECKS_EXIT=$code run "$S" checks 42
		[ "$status" -eq 1 ] || {
			echo "gh exit $code: status $status"
			return 1
		}
		[[ "$output" == *"Check ci/lint: failed."* ]] || false
	done
}

@test "checks --watch still reports a check that failed after the wait" {
	jq '. + [{bucket: "fail", link: "https://github.com/acme/app/actions/runs/702/job/4", name: "lint", workflow: "ci"}]' \
		"$BASE/checks.json" >"$CASE/checks.json"
	run "$S" checks 42 --watch
	[ "$status" -eq 1 ]
	grep -qx 'pr checks 42 --watch' "$GH_LOG"
	[[ "$output" == *"Check ci/lint: failed."* ]] || false
}

# ------------------------------------------------------------------ merge

@test "merge reads the rules of the base branch of the PR" {
	echo '.baseRefName = "release"' >"$CASE/pr.json.jq"
	echo '[]' >"$CASE/rules-release.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"The rules of release do not require the pr-shepherd check"* ]] || false
}

@test "merge refuses a ruleset that requires other checks and not pr-shepherd" {
	echo '[{"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "ci"}]}}]' >"$CASE/rules.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"do not require the pr-shepherd check"* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

@test "merge exits 2 when it cannot read the rules or cannot turn on auto-merge" {
	GH_FAIL="rules/branches" run "$S" merge 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the rules of main."* ]] || false
	GH_FAIL="pr merge" run "$S" merge 42
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot turn on auto-merge for PR #42."* ]] || false
}

@test "merge refuses while the trace has a review row, and arms auto-merge once the user confirms" {
	echo '.[0].description = "req=@REQ@ issue=@ISSUE@ review=2"' >"$CASE/statuses.json.jq"
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Notes' '' '- R2: the test folder holds the case.' >"$CASE/body.txt"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"The trace rows R2 need a human review. Ask the user to read them in the trace comment, then run: shepherd.sh merge 42 --confirmed-by-user"* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
	run "$S" merge 42 --confirmed-by-user
	[ "$status" -eq 0 ]
	grep -qx 'pr merge 42 --auto --squash' "$GH_LOG"
	# The confirmation stays on the PR, before auto-merge turns on.
	[ "$(logged_body)" = "$(printf '%s\n' 'review-rows: 2' 'confirmed-by-user: yes' 'The user read the review rows R2 of the trace on 01234567 and confirmed the merge.')" ]
	[ "$(grep -n 'issues/42/comments' "$GH_LOG" | cut -d: -f1)" -lt "$(grep -n 'pr merge' "$GH_LOG" | cut -d: -f1)" ]
}

# A confirmed merge on a PR with a justified review row, in the state $1.
# It must stop with the state named and write nothing to GitHub.
merge_refuses_state() {
	echo ".state = \"$1\"" >"$CASE/pr.json.jq"
	echo '.[0].description = "req=@REQ@ issue=@ISSUE@ review=2"' >"$CASE/statuses.json.jq"
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Notes' '' '- R2: the test folder holds the case.' >"$CASE/body.txt"
	run "$S" merge 42 --confirmed-by-user
	[ "$status" -eq 1 ]
	[ "$output" = "PR #42 is $2. There is nothing to merge." ]
	run ! grep -q 'issues/42/comments' "$GH_LOG" 2>/dev/null
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

@test "merge refuses a merged PR and writes no comment" {
	merge_refuses_state MERGED merged
}

@test "merge refuses a closed PR and writes no comment" {
	merge_refuses_state CLOSED closed
}

@test "merge writes no confirmation comment for a trace without review rows" {
	run "$S" merge 42 --confirmed-by-user
	[ "$status" -eq 0 ]
	run ! grep -q 'comments' "$GH_LOG"
}

@test "merge exits 2 and does not turn on auto-merge when it cannot write the confirmation" {
	echo '.[0].description = "req=@REQ@ issue=@ISSUE@ review=2"' >"$CASE/statuses.json.jq"
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Notes' '' '- R2: the test folder holds the case.' >"$CASE/body.txt"
	GH_FAIL="issues/42/comments --silent" run "$S" merge 42 --confirmed-by-user
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot write the confirmation comment."* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG"
}

@test "merge refuses a review row without a justification, also when the user confirms" {
	echo '.[0].description = "req=@REQ@ issue=@ISSUE@ review=2"' >"$CASE/statuses.json.jq"
	run "$S" merge 42 --confirmed-by-user
	[ "$status" -eq 1 ]
	[[ "$output" == *'R2: the trace marks the row "review"'*"Fix the problems above before merge."* ]] || false
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

@test "merge says that GitHub merges the PR when every required check passes" {
	run "$S" merge 42
	[ "$status" -eq 0 ]
	[ "$output" = "Auto-merge is on for PR #42. GitHub merges it when every required check passes." ]
}

@test "merge needs no trace for a Dependabot PR, but still wants the other checks and the ruleset" {
	cp "$GOOD/dependabot/body.txt" "$GOOD/dependabot/statuses.json" "$GOOD/dependabot/threads.json" "$CASE/"
	echo '.author = {"login": "app/dependabot"}' >"$CASE/pr.json.jq"
	run "$S" merge 42
	[ "$status" -eq 0 ]
	grep -qx 'pr merge 42 --auto --squash' "$GH_LOG"
	jq '. + [{bucket: "fail", link: "https://ci.example.com/1", name: "lint", workflow: ""}]' "$BASE/checks.json" >"$CASE/checks.json"
	rm "$GH_LOG"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	run ! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

# ----------------------------------------------------------------- disarm

@test "disarm tells the author which PR it turned off and what to run next" {
	echo 42 >"$CASE/closing.txt"
	run "$S" disarm 11
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42: auto-merge is off, because issue #11 changed. Run shepherd.sh verify 42 again." ]
}

@test "disarm exits 1 when it cannot turn off one PR, and still tries the others" {
	printf '42\n43\n' >"$CASE/closing.txt"
	GH_FAIL="pr merge 42 --disable-auto" run "$S" disarm 11
	[ "$status" -eq 1 ]
	[[ "$output" == *"PR #42: could not turn off auto-merge."* ]] || false
	[[ "$output" == *"PR #43: auto-merge is off, because issue #11 changed."* ]] || false
	grep -qx 'pr merge 43 --disable-auto' "$GH_LOG"
}

@test "disarm exits 2 when it cannot read the PRs of the issue" {
	GH_FAIL="closedByPullRequestsReferences" run "$S" disarm 11
	[ "$status" -eq 2 ]
	[[ "$output" == *"Cannot read the PRs that close issue #11."* ]] || false
}

# carry reads the trace of the old head $BEFORE from statuses.json and
# writes to the new head, the head of the base PR. The new head has no
# trace unless a test says so.
carry_setup() {
	BEFORE=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
	AFTER=0123456789abcdef0123456789abcdef01234567
	echo '[]' >"$CASE/statuses-$AFTER.json"
}

@test "carry copies a fresh success trace to the new head, and check then passes" {
	carry_setup
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	[[ "$output" == *"Trace: carried success from bbbbbbbb to 01234567."* ]] || false
	grep -q "^api repos/{owner}/{repo}/statuses/$AFTER -f state=success -f context=pr-shepherd/trace -f description=req=[0-9a-f]\{8\} issue=[0-9a-f]\{8\} review= carried from bbbbbbbb -f target_url=https://github.com/acme/app/pull/42#issuecomment-9002 --silent$" "$GH_LOG"
	desc=$(sed -n 's/.*-f description=\(.*\) -f target_url.*/\1/p' "$GH_LOG")
	jq --arg d "$desc" '.[0].description = $d' "$BASE/statuses.json" >"$CASE/statuses-$AFTER.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "carry keeps the review list and replaces an older carried-from part" {
	carry_setup
	jq '.[0].description = "req=@REQ@ issue=@ISSUE@ review=2,4 carried from aaaaaaaa"' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	grep -q -- "-f description=req=[0-9a-f]\{8\} issue=[0-9a-f]\{8\} review=2,4 carried from bbbbbbbb -f target_url" "$GH_LOG"
}

@test "carry writes nothing when the carried description would pass 140 characters" {
	carry_setup
	rows=$(seq -s, 1 40)
	jq --arg r "$rows" '.[0].description = "req=@REQ@ issue=@ISSUE@ review=\($r)"' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	[ "$output" = "The carried description is longer than 140 characters. Run: shepherd.sh verify 42" ]
	[ ! -f "$GH_LOG" ]
}

@test "carry writes nothing when the old trace is stale or not a success" {
	carry_setup
	for change in '.[0].state = "failure"' '.[0].description = "req=deadbeef issue=@ISSUE@"' \
		'.[0].description = "req=@REQ@ issue=deadbeef"' '[]'; do
		jq "$change" "$BASE/statuses.json" >"$CASE/statuses.json"
		run "$S" carry 42 "$BEFORE" "$AFTER"
		[ "$status" -eq 0 ]
		[[ "$output" == *"Run: shepherd.sh verify 42"* ]] || false
	done
	[[ "$output" == *"bbbbbbbb has no trace."* ]] || false
	[ ! -f "$GH_LOG" ]
}

@test "carry names the cause when it writes nothing" {
	carry_setup
	jq '.[0].state = "failure"' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$output" = "The trace of bbbbbbbb is failure. Run: shepherd.sh verify 42" ]
	jq '.[0].description = "req=deadbeef issue=@ISSUE@"' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$output" = "The Requirements section changed after verify. Run: shepherd.sh verify 42" ]
	jq '.[0].description = "req=@REQ@ issue=deadbeef"' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$output" = "Issue #11 changed after verify. Run: shepherd.sh verify 42" ]
}

@test "carry keeps a trace that the new head has already" {
	carry_setup
	rm "$CASE/statuses-$AFTER.json"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	[ "$output" = "01234567 has a trace already. Nothing to carry." ]
	[ ! -f "$GH_LOG" ]
}

@test "carry writes nothing for a commit that is no longer the head" {
	carry_setup
	run "$S" carry 42 "$BEFORE" cccccccccccccccccccccccccccccccccccccccc
	[ "$status" -eq 0 ]
	[ "$output" = "cccccccc is no longer the head of PR #42. Nothing to carry." ]
	[ ! -f "$GH_LOG" ]
}

@test "carry writes nothing for an exempt PR, a PR without a closing line or an issue without items" {
	carry_setup
	echo '.labels = [{"name": "pr:no-issue"}]' >"$CASE/pr.json.jq"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[[ "$output" == *"exempt"* ]] || false
	rm "$CASE/pr.json.jq"
	cp "$SKILL_DIR/tests/fixtures/prs/bad/no-closes/body.txt.sed" "$CASE/"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	[[ "$output" == *'no "Closes #<issue>" line. Nothing to carry.'* ]] || false
	rm "$CASE/body.txt.sed"
	cp "$SKILL_DIR/tests/fixtures/prs/bad/issue-without-items/issue.txt.sed" "$CASE/"
	run "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 0 ]
	[ "$output" = "Issue #11 has no items. Nothing to carry." ]
	[ ! -f "$GH_LOG" ]
}

@test "carry exits 2 on a wrong SHA, a failed read or a failed write" {
	carry_setup
	run "$S" carry 42 "$BEFORE" HEAD
	[ "$status" -eq 2 ]
	GH_FAIL="commits/$BEFORE/statuses" run --separate-stderr "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 2 ]
	[[ "$stderr" == *"Cannot read the statuses of $BEFORE." ]] || false
	GH_FAIL="statuses/$AFTER -f" run --separate-stderr "$S" carry 42 "$BEFORE" "$AFTER"
	[ "$status" -eq 2 ]
	[[ "$stderr" == *"Cannot write the pr-shepherd/trace status." ]] || false
}

# -------------------------------------------------------------- leftovers

# Write the base body plus a "## Leftovers" section with the lines "$@" to
# the case. The PR has the state $STATE, MERGED by default.
leftover_case() {
	echo ".state = \"${STATE:-MERGED}\"" >"$CASE/pr.json.jq"
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Leftovers' '' "$@" >"$CASE/body.txt"
}

# Print the marker of the leftover text $2 of the PR $1.
marker_of() {
	(
		source "$S"
		leftover_marker "$1" "$2"
	)
}

# Print the number of issues that the run filed.
filed() {
	[[ -f "$GH_LOG" ]] || {
		echo 0
		return
	}
	grep -c '^api repos/{owner}/{repo}/issues -f title=' "$GH_LOG" || true
}

@test "reply defers a finding to a leftover and tells the author to add the item" {
	run "$S" reply 42 PRRT_bot deferred --reason "needs its own change" --leftover "chore(tooling):  fix the loop"
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Triaged thread PRRT_bot as deferred, and resolved it.' \
		'Add this line to "## Leftovers" of PR #42: - [ ] chore(tooling): fix the loop')" ]
	[ "$(logged_body)" = "$(printf '%s\n' 'triage: deferred' 'reason: needs its own change' 'leftover: chore(tooling): fix the loop')" ]
	grep -q 'resolveReviewThread' "$GH_LOG"
}

@test "reply says nothing more when the body has the leftover item" {
	STATE=OPEN leftover_case '- [ ] chore(tooling): fix the loop'
	run "$S" reply 42 PRRT_bot deferred --reason later --leftover "chore(tooling): fix the loop"
	[ "$status" -eq 0 ]
	[ "$output" = "Triaged thread PRRT_bot as deferred, and resolved it." ]
}

@test "reply asks the user before it defers a human finding, and then records the user" {
	run "$S" reply 42 503 deferred --reason later --leftover "chore(tooling): rename the test"
	[ "$status" -eq 1 ]
	[ "$output" = "A human wrote this finding. Ask the user to confirm the deferral, then add --confirmed-by-user." ]
	[ ! -f "$GH_LOG" ]
	run "$S" reply 42 503 deferred --reason later --leftover "chore(tooling): rename the test" --confirmed-by-user
	[ "$status" -eq 0 ]
	[[ "$output" == "Triaged review 503 as deferred."* ]] || false
	[ "$(logged_body)" = "$(printf '%s\n' 'review: 503' 'triage: deferred' 'reason: later' 'leftover: chore(tooling): rename the test' 'confirmed-by-user: yes')" ]
}

@test "reply wants a valid leftover for a deferred finding, and no leftover for the others" {
	run "$S" reply 42 PRRT_bot deferred --reason later
	[ "$status" -eq 2 ]
	[[ "$output" == *'A deferred finding needs --leftover'* ]] || false
	run "$S" reply 42 PRRT_bot deferred --reason later --leftover "fix the loop"
	[ "$status" -eq 2 ]
	[[ "$output" == *'--leftover: "fix the loop" has no "<type>(<scope>): " prefix.'* ]] || false
	run "$S" reply 42 PRRT_bot deferred --reason later --leftover "feat(tooling): fix the loop"
	[ "$status" -eq 2 ]
	[[ "$output" == *'"feat" is no type. Use one of: bug chore enhancement.'* ]] || false
	run "$S" reply 42 PRRT_bot rejected --reason no --leftover "chore(tooling): fix the loop"
	[ "$status" -eq 2 ]
	[[ "$output" == *'Only a deferred finding takes --leftover.'* ]] || false
	[ ! -f "$GH_LOG" ]
}

@test "check reads back a deferred triage, and passes once the body has the open item" {
	echo '.reviewThreads.nodes[0].comments.nodes |= .[0:1]' >"$CASE/threads.json.jq"
	run "$S" reply 42 PRRT_bot deferred --reason later --leftover "chore(tooling): fix the loop"
	[ "$status" -eq 0 ]
	jq --arg b "$(logged_body)" '.reviewThreads.nodes[0].comments.nodes[1] = {"author": {"login": "alice", "__typename": "User"}, "body": $b}' \
		"$BASE/threads.json" >"$CASE/threads.json"
	run "$S" check 42
	[ "$status" -eq 1 ]
	[ "$output" = 'Thread PRRT_bot (codex[bot]): "## Leftovers" has no open item for the deferred finding. Add: - [ ] chore(tooling): fix the loop' ]
	STATE=OPEN leftover_case '- [ ] chore(tooling): fix the loop'
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "merge lists the open leftovers that the merge turns into issues" {
	STATE=OPEN leftover_case '- [ ] chore(tooling): first item' '  - a sub-item' '- [x] chore(tooling): dropped'
	run "$S" merge 42
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Auto-merge is on for PR #42. GitHub merges it when every required check passes.' \
		'After the merge, the leftovers workflow files one issue for each of these leftovers:' '- chore(tooling): first item')" ]
}

@test "leftovers files nothing for a PR that is not merged, and points to --dry-run" {
	STATE=OPEN leftover_case '- [ ] chore(tooling): first item'
	run "$S" leftovers 42
	[ "$status" -eq 1 ]
	[ "$output" = "PR #42 is open. Its leftovers become issues only after the merge. To see them, run: shepherd.sh leftovers 42 --dry-run" ]
	[ ! -f "$GH_LOG" ]
}

@test "leftovers --dry-run prints each issue and files nothing" {
	STATE=OPEN leftover_case '- [ ] chore(tooling): Pin the Vale package version' '  - .vale.ini names an exact release.' \
		'- [ ] bug(agents): the loop skips the last item'
	run "$S" leftovers 42 --dry-run
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1' 'Title: Pin the Vale package version' 'Labels: type:chore scope:tooling origin:leftover' '' \
		'### Scope' '' 'tooling' '' '### What and why' '' 'PR #42 listed this work in its Leftovers section, and the leftovers workflow filed this issue after the merge. This issue is a sub-issue of issue #11, which the PR worked on.' '' 'Before work starts, add the other required fields of the issue form of its type. Then make each Done-when item a checkable statement, because the pr-shepherd skill copies each one as an R item.' '' '### Done when' '' \
		'- [ ] .vale.ini names an exact release.' '' "$(marker_of 42 'chore(tooling): Pin the Vale package version')" '' \
		'Leftover 2' 'Title: the loop skips the last item' 'Labels: type:bug scope:agents origin:leftover' '' \
		'### Scope' '' 'agents' '' '### What and why' '' 'PR #42 listed this work in its Leftovers section, and the leftovers workflow filed this issue after the merge. This issue is a sub-issue of issue #11, which the PR worked on.' '' 'Before work starts, add the other required fields of the issue form of its type. Then make each Done-when item a checkable statement, because the pr-shepherd skill copies each one as an R item.' '' '### Done when' '' \
		'- [ ] the loop skips the last item' '' "$(marker_of 42 'bug(agents): the loop skips the last item')")" ]
	[ ! -f "$GH_LOG" ]
}

@test "leftovers --dry-run names the problem of an item that check rejects" {
	STATE=OPEN leftover_case '- [ ] feat(tooling): add a cache'
	run "$S" leftovers 42 --dry-run
	[ "$status" -eq 1 ]
	[ "$output" = 'Leftover 1: Leftovers: "feat(tooling): add a cache": "feat" is no type. Use one of: bug chore enhancement.' ]
}

@test "leftovers files one issue per open item, links it to the issue of the PR and comments the links once" {
	leftover_case '- [ ] chore(tooling): Pin the Vale package version' '  - .vale.ini names an exact release.' \
		'- [x] chore(tooling): dropped' '- [ ] bug(agents): the loop skips the last item'
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1: filed https://github.com/acme/app/issues/101' 'Leftover 2: filed https://github.com/acme/app/issues/102')" ]
	[ "$(filed)" -eq 2 ]
	grep -qx 'api repos/{owner}/{repo}/issues -f title=Pin the Vale package version -f body=### Scope' "$GH_LOG"
	grep -qx -- '- \[ \] .vale.ini names an exact release.' "$GH_LOG"
	grep -qF "$(marker_of 42 'chore(tooling): Pin the Vale package version') -f labels[]=type:chore -f labels[]=scope:tooling -f labels[]=origin:leftover --jq" "$GH_LOG"
	grep -qF "$(marker_of 42 'bug(agents): the loop skips the last item') -f labels[]=type:bug -f labels[]=scope:agents -f labels[]=origin:leftover --jq" "$GH_LOG"
	run ! grep -q 'dropped' "$GH_LOG"
	grep -qx 'api -X POST repos/{owner}/{repo}/issues/11/sub_issues -F sub_issue_id=9101 --silent' "$GH_LOG"
	grep -qx 'api -X POST repos/{owner}/{repo}/issues/11/sub_issues -F sub_issue_id=9102 --silent' "$GH_LOG"
	[ "$(grep -c '^api repos/{owner}/{repo}/issues/42/comments' "$GH_LOG")" -eq 1 ]
	grep -qx 'api repos/{owner}/{repo}/issues/42/comments --silent -f body=The leftovers workflow filed one issue for each open item of "## Leftovers" in this PR. Each issue has the type and scope labels of its item and the label origin:leftover. Each is a sub-issue of #11.' "$GH_LOG"
	grep -qx -- '- https://github.com/acme/app/issues/101' "$GH_LOG"
	grep -qx -- '- https://github.com/acme/app/issues/102' "$GH_LOG"
	# The comment comes after the last issue.
	[ "$(grep -n 'sub_issue_id=9102' "$GH_LOG" | cut -d: -f1)" -lt "$(grep -n 'issues/42/comments' "$GH_LOG" | cut -d: -f1)" ]
}

@test "leftovers files one issue for an item that the body repeats, and a rerun files nothing" {
	leftover_case '- [ ] chore(tooling): first item' '- [ ] chore(tooling):   first item'
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1: filed https://github.com/acme/app/issues/101' 'Leftover 2 has an issue already.')" ]
	jq -n --arg a "From #42 $(marker_of 42 'chore(tooling): first item')" '[{body: $a}, {body: null}]' >"$CASE/leftover-issues.json"
	rm "$GH_LOG"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1 has an issue already.' 'Leftover 2 has an issue already.')" ]
	[ ! -f "$GH_LOG" ]
}

@test "leftovers does not skip an item whose marker belongs to another PR" {
	leftover_case '- [ ] chore(tooling): first item'
	jq -n --arg a "$(marker_of 7 'chore(tooling): first item')" '[{body: $a}]' >"$CASE/leftover-issues.json"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$(filed)" -eq 1 ]
}

@test "leftovers of a PR without an issue name only the PR and get no sub-issue link" {
	echo '.state = "MERGED" | .labels = [{"name": "pr:no-issue"}]' >"$CASE/pr.json.jq"
	printf '%s\n' '## Summary' '' '- A fix.' '' '## Leftovers' '' '- [ ] chore(tooling): first item' >"$CASE/body.txt"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	grep -qx 'PR #42 listed this work in its Leftovers section, and the leftovers workflow filed this issue after the merge.' "$GH_LOG"
	grep -qx 'api repos/{owner}/{repo}/issues/42/comments --silent -f body=The leftovers workflow filed one issue for each open item of "## Leftovers" in this PR. Each issue has the type and scope labels of its item and the label origin:leftover.' "$GH_LOG"
	run ! grep -q 'sub_issues' "$GH_LOG"
}

@test "leftovers does nothing for a PR without open leftovers or for a Dependabot PR" {
	echo '.state = "MERGED"' >"$CASE/pr.json.jq"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 has no open leftovers." ]
	leftover_case '- [x] chore(tooling): dropped' '- [ ]' '<!-- - [ ] chore(tooling): a hint -->'
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 has no open leftovers." ]
	echo '.state = "MERGED" | .author.login = "app/dependabot"' >"$CASE/pr.json.jq"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 is a Dependabot PR. It has no leftovers." ]
	[ ! -f "$GH_LOG" ]
}

@test "leftovers skips an item that check rejects, files the others and never prints the item" {
	leftover_case '- [ ] feat(tooling): secret words' '- [ ] chore(tooling): second item'
	run "$S" leftovers 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1 is not valid, so it gets no issue. Run: shepherd.sh check 42' \
		'Leftover 2: filed https://github.com/acme/app/issues/101')" ]
	[ "$(filed)" -eq 1 ]
}

@test "leftovers passes \$(touch pwned) and backticks literally and never prints the item" {
	local title='$(touch pwned) `touch pwned2` ${HOME} "quoted" ; touch pwned3'
	leftover_case "- [ ] chore(tooling): $title"
	cd "$BATS_TEST_TMPDIR"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	grep -qxF "api repos/{owner}/{repo}/issues -f title=$title -f body=### Scope" "$GH_LOG"
	grep -qxF -- "- [ ] $title" "$GH_LOG"
	[[ "$output" != *pwned* ]] || false
	[ ! -e pwned ]
	[ ! -e pwned2 ]
	[ ! -e pwned3 ]
}

@test "leftovers cuts a long title to 256 characters and keeps the whole item in the body" {
	local long
	long=$(printf 'a%.0s' $(seq 1 300))
	leftover_case "- [ ] chore(tooling): $long"
	run "$S" leftovers 42
	[ "$status" -eq 0 ]
	grep -qxF "api repos/{owner}/{repo}/issues -f title=${long:0:256} -f body=### Scope" "$GH_LOG"
	grep -qxF -- "- [ ] $long" "$GH_LOG"
}

@test "leftovers goes on after a failed issue, comments the others and exits 1" {
	leftover_case '- [ ] chore(tooling): first item' '- [ ] chore(tooling): second item' '- [ ] chore(tooling): third item'
	GH_FAIL="title=second item" run --separate-stderr "$S" leftovers 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1: filed https://github.com/acme/app/issues/101' 'Cannot file leftover 2.' \
		'Leftover 3: filed https://github.com/acme/app/issues/103')" ]
	grep -qx -- '- https://github.com/acme/app/issues/103' "$GH_LOG"
	run ! grep -qx -- '- https://github.com/acme/app/issues/102' "$GH_LOG"
}

@test "leftovers exits 1 when the sub-issue link or the comment fails, and keeps the issues" {
	leftover_case '- [ ] chore(tooling): first item'
	GH_FAIL="sub_issues" run --separate-stderr "$S" leftovers 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1: filed https://github.com/acme/app/issues/101' 'Cannot add #101 as a sub-issue of #11.')" ]
	grep -q 'issues/42/comments' "$GH_LOG"
	rm "$GH_LOG"
	GH_FAIL="issues/42/comments" run --separate-stderr "$S" leftovers 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' 'Leftover 1: filed https://github.com/acme/app/issues/101' 'Cannot comment on PR #42.')" ]
}

@test "leftovers exits 2 and files nothing when it cannot read the leftover issues" {
	leftover_case '- [ ] chore(tooling): first item'
	GH_FAIL="labels=origin" run --separate-stderr "$S" leftovers 42
	[ "$status" -eq 2 ]
	[[ "$stderr" == *"Cannot read the existing leftover issues." ]] || false
	[ "$(filed)" -eq 0 ]
	echo 'not json' >"$CASE/leftover-issues.json"
	run "$S" leftovers 42
	[ "$status" -eq 2 ]
	[ "$(filed)" -eq 0 ]
}

@test "a leftover issue has the headings that the scope workflow and requirements read" {
	source "$S"
	body=$(leftover_body 'chore(tooling): Pin the Vale package version' $'.vale.ini names an exact release.\037the lint results stay' 42 11)
	[ "$(issue_items <<<"$body")" = "$(printf '%s\n' '.vale.ini names an exact release.' 'the lint results stay')" ]
	# scripts/issue-scope-label.sh reads the first line after "### Scope".
	[ "$(awk '/^### / { inside = ($0 == "### Scope"); next } inside && NF { print; exit }' <<<"$body")" = tooling ]
	# The marker equals the one of the spring-ref-arch script for the same item.
	[ "$(leftover_marker 7 'first item')" = '<!-- leftover:7:0bd30fb1d58d -->' ]
}

@test "leftover_items keeps open items with their sub-items and drops the rest" {
	source "$S"
	body=$(printf '%s\n' '- [ ] before the section' '## Leftovers' '' '- [ ]   chore(tooling):  first   item  ' \
		'  - sub one' '' '    * [ ] sub two' '- [x] ticked' '  - sub of ticked' '* [ ] chore(agents): star item' \
		'- plain' 'A paragraph.' '  - stray sub-item' '- [ ]' '## Notes' '- [ ] after the section')
	[ "$(leftover_items <<<"$body")" = "$(printf '%s\n' $'item\tchore(tooling): first item\tsub one\037sub two' \
		$'item\tchore(agents): star item\t' $'plain\tplain\t')" ]
}

# --------------------------------------------------------------- discover

@test "discover lists each prose text and each rejection reason that states a follow-up" {
	dk_responder <<<'[[ "$text" == *LATER* ]] || DK_P=0.1'
	printf '%s\n' "$(cat "$BASE/body.txt")" '' '## Notes' '' '- R1: maps one to one.' '- LATER: run the workflow by hand on main.' >"$CASE/body.txt"
	echo '.reviewThreads.nodes[1].comments.nodes[1].body = "triage: rejected\nreason: valid, but LATER in its own PR\nconfirmed-by-user: yes"' >"$CASE/threads.json.jq"
	run "$S" discover 42
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' 'These texts of PR #42 may state follow-up work:' \
		'- Notes: "LATER: run the workflow by hand on main." (95 %)' \
		'- Rejected finding: "valid, but LATER in its own PR" (95 %)' \
		'Move each real follow-up to "## Leftovers". Leave a false alarm as it is.')" ]
	[ "$(grep -c '^---$' "$FAKE_DIR/decisionkit.text")" -eq 4 ]
	grep -qx 'Summary of the pull request:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'Notes of the pull request:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'Reason for a rejected review finding:' "$FAKE_DIR/decisionkit.text"
	grep -q 'Does it state work that is still to do after this pull request' "$FAKE_LOG"
}

@test "discover asks nothing about the R, V and Leftovers items, the closing line, comments and code" {
	dk_responder <<<'[[ "$text" == *LATER* ]] || DK_P=0.1'
	printf '%s\n' 'Closes #11' '' '## Requirements' '' '- [x] R1: LATER' '  - evidence: x' '' '## Verify' '' '- [x] V1 (R1): LATER' '' \
		'## Leftovers' '' '- [ ] chore(tooling): LATER' '' '## Summary' '' '<!-- LATER -->' '```' 'LATER' '```' 'Plain text.' >"$CASE/body.txt"
	echo '.reviewThreads.nodes |= []' >"$CASE/threads.json.jq"
	run "$S" discover 42
	[ "$status" -eq 0 ]
	[ "$output" = "No text of PR #42 states follow-up work. decisionkit checked 1 texts." ]
	[ "$(grep -c '^---$' "$FAKE_DIR/decisionkit.text")" -eq 1 ]
	run ! grep -q LATER "$FAKE_DIR/decisionkit.text"
}

@test "discover joins the lines of a paragraph and asks about each list item on its own" {
	dk_responder <<<'DK_P=0.1'
	printf '%s\n' 'A text before the first heading.' '' '## Notes' '' 'First line' 'second line.' '' '- item one' '  - nested item' '### A heading' >"$CASE/body.txt"
	echo '.reviewThreads.nodes |= []' >"$CASE/threads.json.jq"
	run "$S" discover 42
	[ "$status" -eq 0 ]
	grep -qx 'Body of the pull request:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'First line second line.' "$FAKE_DIR/decisionkit.text"
	grep -qx 'item one' "$FAKE_DIR/decisionkit.text"
	grep -qx 'nested item' "$FAKE_DIR/decisionkit.text"
	run ! grep -q 'A heading' "$FAKE_DIR/decisionkit.text"
}

@test "discover marks a true answer below 0.8 as uncertain" {
	dk_responder <<<'if [[ "$text" == *LATER* ]]; then DK_P=0.6; else DK_P=0.1; fi'
	printf '%s\n' '## Notes' '' '- LATER: score it again.' >"$CASE/body.txt"
	echo '.reviewThreads.nodes |= []' >"$CASE/threads.json.jq"
	run "$S" discover 42
	[ "$status" -eq 1 ]
	[[ "$output" == *'- Notes: "LATER: score it again." (60 %, uncertain)'* ]] || false
}

@test "discover exits 2 when decisionkit or a read fails, and skips a Dependabot PR" {
	DK_FAIL=1 run --separate-stderr "$S" discover 42
	[ "$status" -eq 2 ]
	[[ "$stderr" == *"decisionkit failed. Run: decisionkit status"* ]] || false
	GH_FAIL="reviewThreads" run --separate-stderr "$S" discover 42
	[ "$status" -eq 2 ]
	[[ "$stderr" == *"Cannot read the reviews of PR #42."* ]] || false
	echo '.author.login = "app/dependabot"' >"$CASE/pr.json.jq"
	run "$S" discover 42
	[ "$status" -eq 0 ]
	[ "$output" = "PR #42 is a Dependabot PR. It has no leftovers." ]
}
