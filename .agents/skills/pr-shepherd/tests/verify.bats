#!/usr/bin/env bats

# Tests for the shepherd commands that call decisionkit or write to GitHub:
# verify, findings, reply, merge and disarm. The fake gh of helpers/gh
# serves the base PR fixture and logs each write. A fake decisionkit
# answers true, unless the text holds the word WRONG. The real decide.sh
# runs between them, so the tests also cover the questions file.

setup() {
	SKILL_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
	S="$SKILL_DIR/scripts/shepherd.sh"
	export SHEPHERD=$S
	export BASE="$SKILL_DIR/tests/fixtures/prs/base"
	export CASE="$BATS_TEST_TMPDIR/case"
	mkdir -p "$CASE" "$BATS_TEST_TMPDIR/bin"
	export GH_LOG="$BATS_TEST_TMPDIR/gh.log"
	export DK_LOG="$BATS_TEST_TMPDIR/dk.log"
	ln -s "$SKILL_DIR/tests/helpers/gh" "$BATS_TEST_TMPDIR/bin/gh"
	cat >"$BATS_TEST_TMPDIR/bin/decisionkit" <<'STUB'
#!/usr/bin/env bash
kind=$1 text=""
prev=""
for arg in "$@"; do
	[[ "$prev" == --context ]] && text=$arg
	prev=$arg
done
printf '%s\n---\n' "$text" >>"$DK_LOG"
p=0.95
[[ "$text" == *WRONG* ]] && p=0.1
if [[ "$kind" == score ]]; then
	printf '{"answers":{"q":{"type":"score","expected_level":0.2,"most_likely":"low","probabilities":{"low":0.85,"medium":0.1,"high":0.05}}}}\n'
	exit 0
fi
printf '{"answers":{"q":{"type":"binary","probability_true":%s}}}\n' "$p"
[[ "$p" == 0.95 ]]
STUB
	chmod +x "$BATS_TEST_TMPDIR/bin/decisionkit"
	PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

@test "verify asks both questions for each R item and writes a success trace" {
	echo '7001 completed' >"$CASE/runs.txt"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[ "$(grep -c '^Issue item:$' "$DK_LOG")" -eq 3 ]
	[ "$(grep -c '^Claim:$' "$DK_LOG")" -eq 3 ]
	# R1 has sub-tasks, R2 has none.
	grep -qx -- '- add the tick rule to the check' "$DK_LOG"
	grep -qx '(none)' "$DK_LOG"
	[[ "$output" == *"| R1 | ok 0.95 | ok 0.95 |"* ]]
	# The base PR has no trace comment, so verify writes a new one.
	grep -q '^api repos/{owner}/{repo}/issues/42/comments -f body=<!-- pr-shepherd-trace:v1 -->' "$GH_LOG"
	grep -q '^api repos/{owner}/{repo}/statuses/0123456789abcdef0123456789abcdef01234567 -f state=success -f context=pr-shepherd/trace -f description=req=[0-9a-f]\{8\} issue=[0-9a-f]\{8\} -f target_url=https://' "$GH_LOG"
	grep -qx 'run rerun 7001' "$GH_LOG"
}

@test "the hashes that verify writes make check see a fresh trace" {
	run "$S" verify 42
	[ "$status" -eq 0 ]
	desc=$(sed -n 's/.*-f description=\(req=[0-9a-f]* issue=[0-9a-f]*\) .*/\1/p' "$GH_LOG")
	[ -n "$desc" ]
	jq --arg d "$desc" '.[0].description = $d' "$BASE/statuses.json" >"$CASE/statuses.json"
	run "$S" check 42
	[ "$status" -eq 0 ]
}

@test "verify writes a failure trace when an answer is false" {
	sed 's/R1.1: add the tick rule to the check/R1.1: add a WRONG rule/' "$BASE/body.txt" >"$CASE/body.txt"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"| R1 | FAIL 0.1 | FAIL 0.1 |"* ]]
	grep -q -- '-f state=failure' "$GH_LOG"
}

@test "verify updates the trace comment that exists" {
	jq '. + [{"id": 9002, "html_url": "https://x/9002", "body": "<!-- pr-shepherd-trace:v1 -->\nold"}]' \
		"$BASE/comments.json" >"$CASE/comments.json"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	grep -q '^api -X PATCH repos/{owner}/{repo}/issues/comments/9002 -f body=' "$GH_LOG"
	! grep -q 'issues/42/comments -f body' "$GH_LOG"
}

@test "verify writes no trace when the R items do not match the issue" {
	sed 's/R2: the check fails on/R2: the check warns on/' "$BASE/body.txt" >"$CASE/body.txt"
	run "$S" verify 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"R2: the text differs from item 2 of issue #11."* ]]
	[ ! -f "$DK_LOG" ]
	! grep -q statuses "$GH_LOG" 2>/dev/null
}

@test "verify skips an exempt PR" {
	echo '.labels = [{"name": "pr:no-issue"}]' >"$CASE/pr.json.jq"
	run "$S" verify 42
	[ "$status" -eq 0 ]
	[[ "$output" == *"exempt"* ]]
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
	[[ "$output" == *"Ask the user"* ]]
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
	[[ "$output" == *"commit SHA"* ]]
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
	[[ "$output" == *"do not require the pr-shepherd check"* ]]
	! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}

@test "merge refuses a PR that fails check" {
	echo '[]' >"$CASE/statuses.json"
	run "$S" merge 42
	[ "$status" -eq 1 ]
	[[ "$output" == *"Fix the problems above before merge."* ]]
}

@test "merge turns on auto-merge with rebase when every rule holds" {
	run "$S" merge 42
	[ "$status" -eq 0 ]
	grep -qx 'pr merge 42 --auto --rebase' "$GH_LOG"
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
	[[ "$output" == *"No open PR with auto-merge closes issue #11."* ]]
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
	[[ "$output" == *"Check ci/lint: failed."* ]]
	! grep -q 'pr merge' "$GH_LOG" 2>/dev/null
}
