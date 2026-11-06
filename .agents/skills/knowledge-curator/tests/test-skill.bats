#!/usr/bin/env bats

# Tests for scripts/test-skill.sh. Fake claude and decisionkit commands
# replace the real ones, so no test calls an LLM. Each test builds a small
# repository with a copy of the script, the two question blocks that it
# reads, and a skill named demo.

load helpers/stub

setup() {
	REPO="$BATS_TEST_TMPDIR/repo"
	CURATOR="$REPO/.agents/skills/knowledge-curator"
	DEMO="$REPO/.agents/skills/demo"
	mkdir -p "$CURATOR/scripts" "$REPO/.agents/skills/cold-reader" "$DEMO/tests"
	cp "$BATS_TEST_DIRNAME/../scripts/test-skill.sh" "$CURATOR/scripts/"
	cat >"$CURATOR/SKILL.md" <<'EOF'
```sh skill-tests
Q_KNOW="Same facts?"
KNOW_MIN=0.5
```
EOF
	cat >"$REPO/.agents/skills/cold-reader/SKILL.md" <<'EOF'
```sh questions
Q_SLOP="How much slop?"
SLOP_MAX=0.65
```
EOF
	cat >"$DEMO/SKILL.md" <<'EOF'
---
name: demo
description: FRONT-MATTER-TEXT
---

# Demo

Intro text.

## First

First text.

## Second

Second text.
EOF
	stub_command claude
	stub_command decisionkit
	export SKILL_TEST_RUNS=1 SKILL_TEST_JOBS=2
	SCRIPT="$CURATOR/scripts/test-skill.sh"
}

# A claude responder that loads the skill named in $1 when the task holds
# "demo", and the skill named in $2 for any other task.
fire_responder() {
	responder claude <<EOF
skill=$2
[[ "\${@: -1}" == *demo* ]] && skill=$1
printf '{"type":"system","subtype":"init"}\n'
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"%s"}}]}}\n' "\$skill"
printf '{"type":"result","subtype":"error_max_turns"}\n'
exit 1
EOF
}

triggers() {
	printf '%s\n' "$@" >"$DEMO/tests/triggers.txt"
}

@test "triggers passes when a + task fires and a - task stays quiet" {
	fire_responder demo other
	triggers "# comment" "" "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"+    fire  1/1   ok"* ]]
	[[ "$output" == *"-    quiet 0/1   ok"* ]]
}

@test "triggers fails when a + task does not fire" {
	fire_responder other other
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"+    fire  0/1   WRONG"* ]]
	[[ "$output" == *"loaded: other (1)"* ]]
	[[ "$output" == *"-    quiet 0/1   ok"* ]]
	[[ "$output" != *"loaded: other (1)"*"loaded:"* ]]
}

@test "triggers fails when a - task fires" {
	fire_responder demo demo
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"-    quiet 1/1   WRONG"* ]]
}

@test "triggers counts a plugin skill by its name" {
	fire_responder plugin:demo other
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
}

@test "triggers lets the majority of the runs decide" {
	# Sequential runs: the first two runs fire, the third does not.
	responder claude <<EOF
count=\$(cat "$BATS_TEST_TMPDIR/count" 2>/dev/null || echo 0)
echo \$((count + 1)) >"$BATS_TEST_TMPDIR/count"
skill=other
((count < 2)) && skill=demo
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"%s"}}]}}\n' "\$skill"
printf '{"type":"result","subtype":"success"}\n'
exit 0
EOF
	triggers "+ do the demo task"
	SKILL_TEST_RUNS=3 SKILL_TEST_JOBS=1 run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"2/3   ok"* ]]
}

@test "triggers exits 2 when a headless run fails" {
	responder claude <<'EOF'
printf '{"type":"result","subtype":"error_during_execution"}\n'
exit 1
EOF
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
}

@test "triggers runs claude from the repository root with only the Skill tool" {
	fire_responder demo other
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	grep -q -- "--tools Skill --setting-sources project" "$BATS_TEST_TMPDIR/claude.log"
	grep -q -- "--model haiku" "$BATS_TEST_TMPDIR/claude.log"
}

@test "triggers rejects a line without + or -" {
	triggers "do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
}

@test "triggers skips a user-only skill without a headless run" {
	# The flag makes demo a user-only skill. No model can load it, so it
	# needs no triggers.txt.
	awk '{ print } /^name: demo$/ { print "disable-model-invocation: true" }' \
		"$DEMO/SKILL.md" >"$DEMO/SKILL.md.new"
	mv "$DEMO/SKILL.md.new" "$DEMO/SKILL.md"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"skip: demo is a user-only skill."* ]]
	[ ! -e "$BATS_TEST_TMPDIR/claude.log" ]
}

# A claude responder for the cold reader. It saves the prompt and answers
# every question with "answer <n>".
reader_responder() {
	responder claude <<EOF
cat >"$BATS_TEST_TMPDIR/prompt.txt"
printf '{"subtype":"success","structured_output":{"answers":[{"n":1,"answer":"answer 1"},{"n":2,"answer":"answer 2"}]}}\n'
exit 0
EOF
}

# A decisionkit responder for binary questions that returns $1 as p_true
# and $2 as the exit code.
binary_responder() {
	responder decisionkit <<EOF
printf '{"answers":{"q":{"probability_true":%s}}}\n' "$1"
exit $2
EOF
}

knowledge() {
	printf '%s\n' "$@" >"$DEMO/tests/knowledge.txt"
}

@test "knowledge passes when decisionkit accepts every answer" {
	reader_responder
	binary_responder 0.9 0
	knowledge "Q: First question?" "A: First fact." "" "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$BATS_TEST_TMPDIR/decisionkit.log")" -eq 2 ]
}

@test "knowledge sends only SKILL.md and the numbered questions to a cold reader" {
	reader_responder
	binary_responder 0.9 0
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	grep -q "Intro text." "$BATS_TEST_TMPDIR/prompt.txt"
	grep -q "^1. First question?$" "$BATS_TEST_TMPDIR/prompt.txt"
	! grep -q "First fact." "$BATS_TEST_TMPDIR/prompt.txt"
	grep -q -- "--tools '' --setting-sources ''" "$BATS_TEST_TMPDIR/claude.log"
}

@test "knowledge fails and shows both texts when an answer is wrong" {
	reader_responder
	binary_responder 0.1 1
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"* ]]
	[[ "$output" == *"expected: First fact."* ]]
	[[ "$output" == *"answer:   answer 1"* ]]
}

@test "knowledge exits 2 when decisionkit fails" {
	reader_responder
	binary_responder 0 2
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
}

@test "knowledge exits 2 when the cold reader gives no answers" {
	responder claude <<'EOF'
printf '{"subtype":"error_max_turns"}\n'
exit 1
EOF
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
}

@test "knowledge rejects a question without an answer" {
	knowledge "Q: First question?" "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'"First question?" has no "A: " line'* ]]
}

# A decisionkit responder for score questions. It saves each input and
# returns $1 as the expected level.
score_responder() {
	responder decisionkit <<EOF
cat >"\$(mktemp "$BATS_TEST_TMPDIR/section-XXXXXX")"
printf '{"answers":{"q":{"expected_level":%s}}}\n' "$1"
exit 0
EOF
}

@test "slop scores each section and skips the front matter" {
	score_responder 0.2
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$BATS_TEST_TMPDIR/decisionkit.log")" -eq 3 ]
	! grep -q FRONT-MATTER-TEXT "$BATS_TEST_TMPDIR"/section-*
	[[ "$output" == *"## First"* ]]
}

@test "slop fails at SLOP_MAX" {
	score_responder 0.65
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"* ]]
}

@test "slop warns less than 0.1 below SLOP_MAX" {
	score_responder 0.6
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"WARN"* ]]
}

@test "calibrate checks each fixture against its expected side" {
	mkdir -p "$DEMO/tests/fixtures/knowledge"
	printf 'A:\nx\nB:\nx\n' >"$DEMO/tests/fixtures/knowledge/same-x.txt"
	printf 'A:\nx\nB:\ny\n' >"$DEMO/tests/fixtures/knowledge/differ-x.txt"
	responder decisionkit <<'EOF'
p=0.1
grep -qx x <(tail -1) && p=0.9
printf '{"answers":{"q":{"probability_true":%s}}}\n' "$p"
exit 0
EOF
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c ' ok ' <<<"$output")" -eq 2 ]
}

@test "drift exits 2 when the skill has no bats file" {
	run "$SCRIPT" drift "$DEMO"
	[ "$status" -eq 2 ]
}

@test "an unknown layer exits 2" {
	run "$SCRIPT" nope "$DEMO"
	[ "$status" -eq 2 ]
}
