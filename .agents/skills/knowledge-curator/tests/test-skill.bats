#!/usr/bin/env bats

# Tests for scripts/test-skill.sh. Fake claude and decisionkit commands
# (tests/scripts/helpers/fakes.bash) replace the real ones, so no test calls
# an LLM. Each test builds a small
# repository with a link to the script, the two question blocks that it
# reads, and a skill named demo.

ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	REPO="$BATS_TEST_TMPDIR/repo"
	CURATOR="$REPO/.agents/skills/knowledge-curator"
	DEMO="$REPO/.agents/skills/demo"
	mkdir -p "$CURATOR/scripts" "$REPO/.agents/skills/cold-reader" "$DEMO/tests"
	ln -s "$(suite_copy "$ROOT/.agents/skills/knowledge-curator/scripts/test-skill.sh")" "$CURATOR/scripts/test-skill.sh"
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
	fake claude
	fake_decisionkit
	export SKILL_TEST_RUNS=1 SKILL_TEST_JOBS=2
	SCRIPT="$CURATOR/scripts/test-skill.sh"
}

# A claude responder that loads the skill named in $1 when the task holds
# "demo", and the skill named in $2 for any other task.
fire_responder() {
	fake claude - <<EOF
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

# Print the calls of the fake claude.
claude_calls() {
	calls | grep '^claude '
}

@test "triggers passes when a + task fires and a - task stays quiet" {
	fire_responder demo other
	triggers "# comment" "" "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"+    fire  1/1   ok"* ]] || false
	[[ "$output" == *"-    quiet 0/1   ok"* ]] || false
}

@test "triggers fails when a + task does not fire" {
	fire_responder other other
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"+    fire  0/1   WRONG"* ]] || false
	[[ "$output" == *"loaded: other (1)"* ]] || false
	[[ "$output" == *"-    quiet 0/1   ok"* ]] || false
	[[ "$output" != *"loaded: other (1)"*"loaded:"* ]] || false
}

@test "triggers fails when a - task fires" {
	fire_responder demo demo
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"-    quiet 1/1   WRONG"* ]] || false
}

@test "triggers counts a plugin skill by its name" {
	fire_responder plugin:demo other
	triggers "+ do the demo task" "- do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
}

@test "triggers lets the majority of the runs decide" {
	# Sequential runs: the first two runs fire, the third does not.
	fake claude - <<EOF
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
	[[ "$output" == *"2/3   ok"* ]] || false
}

@test "triggers exits 2 when a headless run fails" {
	fake claude - <<'EOF'
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
	claude_calls | grep -q -- "--tools Skill --setting-sources project"
	claude_calls | grep -q -- "--model haiku"
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
	[[ "$output" == *"skip: demo is a user-only skill."* ]] || false
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

# A claude responder for the cold reader. It saves the prompt and answers
# every question with "answer <n>".
reader_responder() {
	fake claude - <<EOF
cat >"$BATS_TEST_TMPDIR/prompt.txt"
printf '{"subtype":"success","structured_output":{"answers":[{"n":1,"answer":"answer 1"},{"n":2,"answer":"answer 2"}]}}\n'
exit 0
EOF
}

knowledge() {
	printf '%s\n' "$@" >"$DEMO/tests/knowledge.txt"
}

@test "knowledge passes when decisionkit accepts every answer" {
	reader_responder
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact." "" "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$FAKE_DIR/decisionkit.argv")" -eq 2 ]
}

@test "knowledge sends only SKILL.md and the numbered questions to a cold reader" {
	reader_responder
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	grep -q "Intro text." "$BATS_TEST_TMPDIR/prompt.txt"
	grep -q "^1. First question?$" "$BATS_TEST_TMPDIR/prompt.txt"
	# A negated command does not fail a test, so the check uses if.
	if grep -q "First fact." "$BATS_TEST_TMPDIR/prompt.txt"; then
		echo "The cold reader prompt holds the expected answer."
		return 1
	fi
	grep -qF -- '<--tools><><--setting-sources><>' "$FAKE_DIR/claude.argv"
}

@test "knowledge fails and shows both texts when an answer is wrong" {
	reader_responder
	export DK_P=0.1
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"* ]] || false
	[[ "$output" == *"expected: First fact."* ]] || false
	[[ "$output" == *"answer:   answer 1"* ]] || false
}

@test "knowledge exits 2 when decisionkit fails" {
	reader_responder
	export DK_FAIL=1
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
}

@test "knowledge exits 2 when the cold reader gives no answers" {
	fake claude - <<'EOF'
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
	[[ "$output" == *'"First question?" has no "A: " line'* ]] || false
}

# Make decisionkit return $1 as the expected level of each score question.
# A responder saves each text in a file of its own.
score_responder() {
	export DK_LEVEL=$1
	dk_responder <<'EOF'
printf '%s\n' "$text" >"$(mktemp "$FAKE_DIR/section-XXXXXX")"
EOF
}

@test "slop scores each section and skips the front matter" {
	score_responder 0.2
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$FAKE_DIR/decisionkit.argv")" -eq 3 ]
	if grep -q FRONT-MATTER-TEXT "$FAKE_DIR"/section-*; then
		echo "A scored section holds the front matter."
		return 1
	fi
	[[ "$output" == *"## First"* ]] || false
}

@test "slop fails at SLOP_MAX" {
	score_responder 0.65
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"* ]] || false
}

@test "slop warns less than 0.1 below SLOP_MAX" {
	score_responder 0.6
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"WARN"* ]] || false
}

@test "calibrate checks each fixture against its expected side" {
	mkdir -p "$DEMO/tests/fixtures/knowledge"
	printf 'A:\nx\nB:\nx\n' >"$DEMO/tests/fixtures/knowledge/same-x.txt"
	printf 'A:\nx\nB:\ny\n' >"$DEMO/tests/fixtures/knowledge/differ-x.txt"
	dk_responder <<'EOF'
DK_P=0.1
[[ "${text##*$'\n'}" == x ]] && DK_P=0.9
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

# The tests below close the gaps of the first set. They cover the rest of
# the use cases and exit paths of the script, layer by layer.

# Print the physical path of the demo repository, as the script sees it.
physical_repo() {
	(cd "$REPO" && pwd -P)
}

@test "a call without a layer and a skill folder, with extra arguments or with a missing folder exits 2 with the usage" {
	# Each row: the arguments. An empty row is a call without arguments.
	while IFS= read -r args; do
		# shellcheck disable=SC2086 # the arguments split into words.
		run "$SCRIPT" $args
		if [[ "$status" -ne 2 || "$output" != *"Usage: "*"drift|triggers|knowledge|slop|calibrate <skill-dir>"* ]]; then
			printf 'args: %s\ngot:  exit %s, %s\n' "$args" "$status" "$output"
			return 1
		fi
	done <<CASES

drift
drift $DEMO extra
drift $BATS_TEST_TMPDIR/none
CASES
}

@test "the internal _fire mode needs a task file and a result file" {
	run "$SCRIPT" _fire only-one
	[ "$status" -eq 2 ]
	run "$SCRIPT" _fire one two three
	[ "$status" -eq 2 ]
}

@test "drift runs bats on the tests folder of the skill and returns its exit code" {
	fake bats
	touch "$DEMO/tests/some.bats"
	run "$SCRIPT" drift "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(cat "$FAKE_DIR/bats.argv")" = "<$(cd "$DEMO" && pwd -P)/tests>" ]
	fake bats - <<'EOF'
exit 1
EOF
	run "$SCRIPT" drift "$DEMO"
	[ "$status" -eq 1 ]
}

@test "drift tells the user where the missing bats file should be" {
	run "$SCRIPT" drift "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"tests holds no .bats file."* ]] || false
}

@test "a skill reached through a symlink gets its real name, and claude runs from the repository root with auto memory off" {
	fake claude - <<'EOF'
pwd -P >"$FAKE_DIR/cwd"
echo "$CLAUDE_CODE_DISABLE_AUTO_MEMORY" >"$FAKE_DIR/memory"
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"demo"}}]}}\n'
printf '{"type":"result","subtype":"success"}\n'
exit 0
EOF
	mkdir -p "$REPO/.claude/skills"
	ln -s ../../.agents/skills/demo "$REPO/.claude/skills/linked"
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$REPO/.claude/skills/linked"
	[ "$status" -eq 0 ]
	[[ "$output" == *"+    fire  1/1   ok"* ]] || false
	[ "$(cat "$FAKE_DIR/cwd")" = "$(physical_repo)" ]
	[ "$(cat "$FAKE_DIR/memory")" = 1 ]
}

@test "triggers starts SKILL_TEST_RUNS runs for each task with the task as the prompt and SKILL_TEST_MODEL as the model" {
	fake claude - <<'EOF'
printf '%s\n' "${@: -1}" >>"$FAKE_DIR/prompts"
printf '{"type":"result","subtype":"success"}\n'
exit 0
EOF
	triggers "+ first task" "- second task"
	SKILL_TEST_RUNS=2 SKILL_TEST_JOBS=1 SKILL_TEST_MODEL=sonnet run "$SCRIPT" triggers "$DEMO"
	[ "$(claude_calls | grep -c '')" -eq 4 ]
	[ "$(claude_calls | grep -c -- '--model sonnet')" -eq 4 ]
	[ "$(sort "$FAKE_DIR/prompts" | paste -sd'|' -)" = "first task|first task|second task|second task" ]
}

@test "triggers gives each headless run one turn, a stream of events and no session, MCP server or extra tool" {
	fire_responder demo other
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	for flag in "-p" "--max-turns 1" "--output-format stream-json" "--verbose" "--strict-mcp-config" "--no-session-persistence" "--tools Skill --setting-sources project"; do
		claude_calls | grep -q -- "$flag" || {
			echo "The trigger call lacks $flag."
			return 1
		}
	done
}

@test "triggers shows no skill when a failed case loaded none" {
	fake claude - <<'EOF'
printf '{"type":"result","subtype":"success"}\n'
exit 0
EOF
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"+    fire  0/1   WRONG"* ]] || false
	[[ "$output" == *"loaded: no skill"* ]] || false
}

@test "triggers fails both signs on a tie, because only a majority decides" {
	# Sequential runs: an even run loads the skill, an odd run does not.
	fake claude - <<'EOF'
count=$(cat "$FAKE_DIR/count" 2>/dev/null || echo 0)
echo $((count + 1)) >"$FAKE_DIR/count"
skill=other
((count % 2 == 0)) && skill=demo
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"%s"}}]}}\n' "$skill"
printf '{"type":"result","subtype":"success"}\n'
exit 0
EOF
	triggers "+ do the demo task" "- do another task"
	SKILL_TEST_RUNS=2 SKILL_TEST_JOBS=1 run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 1 ]
	[[ "$output" == *"+    fire  1/2   WRONG"* ]] || false
	[[ "$output" == *"-    quiet 1/2   WRONG"* ]] || false
}

@test "triggers exits 2 when a headless run prints no result" {
	fake claude - <<'EOF'
exit 0
EOF
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"headless runs failed. Check that claude works: claude -p hello"* ]] || false
}

@test "triggers exits 2 when triggers.txt is missing or holds no task" {
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Missing $(cd "$DEMO" && pwd -P)/tests/triggers.txt."* ]] || false
	triggers "# only a comment" ""
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"triggers.txt holds no task."* ]] || false
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

@test "triggers names the line that starts with neither +, - nor #" {
	triggers "+ do the demo task" "do another task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'a line must start with "+ ", "- " or "#": do another task'* ]] || false
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

@test "triggers reads a last line that has no newline" {
	fire_responder demo other
	printf '+ do the demo task' >"$DEMO/tests/triggers.txt"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"+    fire  1/1   ok"* ]] || false
}

@test "triggers cuts a task of more than 70 characters in its result row, and keeps one of 70" {
	fire_responder demo other
	long="demo$(printf 'a%.0s' $(seq 1 71))"
	exact="$(printf 'b%.0s' $(seq 1 70))"
	triggers "+ $long" "- $exact"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"${long:0:67}..."* ]] || false
	[[ "$output" != *"${long:0:68}"* ]] || false
	[[ "$output" == *"$exact"* ]] || false
}

@test "triggers does not skip a skill whose front matter turns disable-model-invocation off" {
	fire_responder demo other
	awk '{ print } /^name: demo$/ { print "disable-model-invocation: false" }' \
		"$DEMO/SKILL.md" >"$DEMO/SKILL.md.new"
	mv "$DEMO/SKILL.md.new" "$DEMO/SKILL.md"
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" != *"skip:"* ]] || false
	[ -s "$FAKE_DIR/claude.argv" ]
}

@test "knowledge exits 2 when knowledge.txt is missing" {
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Missing $(cd "$DEMO" && pwd -P)/tests/knowledge.txt."* ]] || false
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

@test "knowledge exits 2 when the curator SKILL.md sets no Q_KNOW or KNOW_MIN" {
	reader_responder
	knowledge "Q: First question?" "A: First fact."
	printf '```sh skill-tests\nQ_KNOW="Same facts?"\n```\n' >"$CURATOR/SKILL.md"
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'The "sh skill-tests" block in '*'must set Q_KNOW and KNOW_MIN.'* ]] || false
	printf '```sh skill-tests\nKNOW_MIN=0.5\n```\n' >"$CURATOR/SKILL.md"
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

@test "knowledge rejects an answer line without a question before it" {
	knowledge "A: Orphan fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'an "A: " line has no question before it'* ]] || false
}

@test "knowledge rejects a last question without an answer" {
	knowledge "Q: First question?" "A: First fact." "Q: Last question?"
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'the question "Last question?" has no "A: " line'* ]] || false
	[ ! -e "$FAKE_DIR/claude.argv" ]
}

@test "knowledge rejects a file without a question" {
	knowledge "# only a comment" ""
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"knowledge.txt holds no question."* ]] || false
}

@test "knowledge rejects a line that starts with neither Q:, A: nor #" {
	knowledge "Q: First question?" "A: First fact." "stray line"
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'a line must start with "Q: ", "A: " or "#": stray line'* ]] || false
}

@test "knowledge tells the cold reader to answer from the document alone and to say not stated" {
	reader_responder
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact." "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	grep -q "Answer each numbered question from the document alone" "$BATS_TEST_TMPDIR/prompt.txt"
	grep -q '"not stated"' "$BATS_TEST_TMPDIR/prompt.txt"
	grep -qx '<document path=".agents/skills/demo/SKILL.md">' "$BATS_TEST_TMPDIR/prompt.txt"
	# The numbered questions come after the document.
	[ "$(grep -n '^</document>$' "$BATS_TEST_TMPDIR/prompt.txt" | cut -d: -f1)" -lt "$(grep -n '^1. First question?$' "$BATS_TEST_TMPDIR/prompt.txt" | cut -d: -f1)" ]
	grep -qx '2. Second question?' "$BATS_TEST_TMPDIR/prompt.txt"
}

@test "knowledge runs the cold reader in an empty folder with no tools, rules, skills or memory" {
	fake claude - <<'EOF'
pwd -P >"$FAKE_DIR/reader-cwd"
ls -A >"$FAKE_DIR/reader-files"
echo "$CLAUDE_CODE_DISABLE_AUTO_MEMORY" >"$FAKE_DIR/reader-memory"
cat >/dev/null
printf '{"subtype":"success","structured_output":{"answers":[{"n":1,"answer":"answer 1"}]}}\n'
exit 0
EOF
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact."
	SKILL_TEST_MODEL=sonnet run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(cat "$FAKE_DIR/reader-cwd")" != "$(physical_repo)" ]
	[ ! -s "$FAKE_DIR/reader-files" ]
	[ ! -d "$(cat "$FAKE_DIR/reader-cwd")" ]
	[ "$(cat "$FAKE_DIR/reader-memory")" = 1 ]
	for flag in "--model sonnet" "--disable-slash-commands" "--strict-mcp-config" "--no-session-persistence" "--output-format json" "--json-schema"; do
		claude_calls | grep -q -- "$flag" || {
			echo "The cold reader call lacks $flag."
			return 1
		}
	done
}

@test "knowledge asks decisionkit with Q_KNOW and KNOW_MIN, and sends the expected answer as A and the reader answer as B" {
	reader_responder
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(cat "$FAKE_DIR/decisionkit.argv")" = '<binary><Same facts?><--threshold><0.5><--json><--quiet>' ]
	[ "$(sed '$d' "$FAKE_DIR/decisionkit.text")" = "$(printf 'A:\nFirst fact.\nB:\nanswer 1')" ]
}

@test "knowledge answers not stated for a question that the reader skipped" {
	fake claude - <<'EOF'
printf '{"subtype":"success","structured_output":{"answers":[{"n":1,"answer":"answer 1"}]}}\n'
exit 0
EOF
	knowledge "Q: First question?" "A: First fact." "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '^A:$' "$FAKE_DIR/decisionkit.text")" -eq 2 ]
	grep -qx 'answer 1' "$FAKE_DIR/decisionkit.text"
	grep -qx 'not stated' "$FAKE_DIR/decisionkit.text"
}

@test "knowledge accepts an answer at KNOW_MIN and rejects one below it" {
	reader_responder
	knowledge "Q: First question?" "A: First fact."
	export DK_P=0.5
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	export DK_P=0.49
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 1 ]
}

@test "knowledge grades every question, and one wrong answer fails the layer" {
	reader_responder
	dk_responder <<'EOF'
[[ "$text" == *"answer 2"* ]] && DK_P=0.1
EOF
	knowledge "Q: First question?" "A: First fact." "Q: Second question?" "A: Second fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 1 ]
	grep -Eq '^0\.9 +ok +First question\?$' <<<"$output"
	grep -Eq '^0\.1 +WRONG +Second question\?$' <<<"$output"
	[[ "$output" == *"expected: Second fact."* ]] || false
	[[ "$output" == *"answer:   answer 2"* ]] || false
}

@test "knowledge exits 2 when decisionkit gives no probability" {
	reader_responder
	dk_responder <<'EOF'
printf 'not json\n'
exit 0
EOF
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed. Run: decisionkit status"* ]] || false
}

@test "knowledge exits 2 when the cold reader output is not a successful list of answers" {
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact."
	fake claude - <<'EOF'
cat "$FAKE_DIR/reply"
exit 0
EOF
	# Each row: what the fake claude prints.
	while IFS= read -r reply; do
		printf '%s\n' "$reply" >"$FAKE_DIR/reply"
		run "$SCRIPT" knowledge "$DEMO"
		if [[ "$status" -ne 2 || "$output" != *"The cold reader gave no answers. Check that claude works: claude -p hello"* ]]; then
			printf 'reply: %s\ngot:   exit %s, %s\n' "$reply" "$status" "$output"
			return 1
		fi
	done <<'CASES'
{"subtype":"success"}
{"subtype":"success","structured_output":{"answers":"none"}}
{"subtype":"error_max_turns","structured_output":{"answers":[]}}

not json
CASES
}

@test "slop exits 2 when the cold-reader skill sets no Q_SLOP or SLOP_MAX" {
	score_responder 0.2
	printf '```sh questions\nQ_SLOP="How much slop?"\n```\n' >"$REPO/.agents/skills/cold-reader/SKILL.md"
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *'The "sh questions" block in '*'must set Q_SLOP and SLOP_MAX.'* ]] || false
	printf '```sh questions\nSLOP_MAX=0.65\n```\n' >"$REPO/.agents/skills/cold-reader/SKILL.md"
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 2 ]
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "slop scores the text before the first ## heading as its own section" {
	score_responder 0.2
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[[ "$output" == *"(before the first ## heading)"* ]] || false
	[[ "$output" == *"## First"* ]] || false
	[[ "$output" == *"## Second"* ]] || false
}

@test "slop asks decisionkit the Q_SLOP question and sends one section at a time" {
	score_responder 0.2
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(sort -u "$FAKE_DIR/decisionkit.argv")" = '<score><How much slop?><none><some><heavy><--json><--quiet>' ]
	# Each saved section holds the text of one heading only.
	[ "$(grep -l 'Intro text.' "$FAKE_DIR"/section-* | wc -l | tr -d ' ')" -eq 1 ]
	[ "$(grep -l 'First text.' "$FAKE_DIR"/section-* | wc -l | tr -d ' ')" -eq 1 ]
	[ "$(grep -l 'Second text.' "$FAKE_DIR"/section-* | wc -l | tr -d ' ')" -eq 1 ]
	[ "$(grep -l -e 'First text.' -e 'Second text.' -e 'Intro text.' "$FAKE_DIR"/section-* | wc -l | tr -d ' ')" -eq 3 ]
	[ "$(cat "$FAKE_DIR"/section-* | grep -c 'text\.')" -eq 3 ]
}

@test "slop skips a section that holds only blank lines" {
	score_responder 0.2
	printf -- '---\nname: demo\ndescription: d\n---\n\n## Only\n\nOnly text.\n' >"$DEMO/SKILL.md"
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$FAKE_DIR/decisionkit.argv")" -eq 1 ]
	[[ "$output" == *"## Only"* ]] || false
	[[ "$output" != *"before the first"* ]] || false
}

@test "slop marks a score ok below the warning band and WARN from its lower edge" {
	score_responder 0.54
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c ' ok ' <<<"$output")" -eq 3 ]
	[[ "$output" != *WARN* ]] || false
	score_responder 0.55
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c ' WARN ' <<<"$output")" -eq 3 ]
}

@test "slop scores every section, and one section at SLOP_MAX fails the layer" {
	dk_responder <<'EOF'
DK_LEVEL=0.1
[[ "$text" == *"First text."* ]] && DK_LEVEL=0.9
EOF
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 1 ]
	grep -Eq '^0\.9 +WRONG +## First$' <<<"$output"
	grep -Eq '^0\.1 +ok +## Second$' <<<"$output"
}

@test "slop exits 2 when decisionkit fails or prints no level" {
	DK_FAIL=1 run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed. Run: decisionkit status"* ]] || false
	dk_responder <<'EOF'
printf 'not json\n'
exit 0
EOF
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 2 ]
}

# A decisionkit responder for the calibrate layer. It answers 0.9 when the
# last line of the text is "x", and 0.1 for any other text.
calibrate_responder() {
	dk_responder <<'EOF'
DK_P=0.1
[[ "${text##*$'\n'}" == x ]] && DK_P=0.9
EOF
}

# Write the fixture $1 of the folder tests/fixtures/knowledge with the B text $2.
knowledge_fixture() {
	mkdir -p "$DEMO/tests/fixtures/knowledge"
	printf 'A:\nx\nB:\n%s\n' "$2" >"$DEMO/tests/fixtures/knowledge/$1"
}

@test "calibrate fails a same fixture that scores below KNOW_MIN and a differ fixture that scores above it" {
	calibrate_responder
	knowledge_fixture same-good.txt x
	knowledge_fixture differ-good.txt y
	knowledge_fixture same-bad.txt y
	knowledge_fixture differ-bad.txt x
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 1 ]
	grep -Eq '^same +0\.9 +ok +same-good\.txt$' <<<"$output"
	grep -Eq '^differ +0\.1 +ok +differ-good\.txt$' <<<"$output"
	grep -Eq '^same +0\.1 +WRONG +same-bad\.txt$' <<<"$output"
	grep -Eq '^differ +0\.9 +WRONG +differ-bad\.txt$' <<<"$output"
}

@test "calibrate counts a fixture at KNOW_MIN as same" {
	export DK_P=0.5
	knowledge_fixture same-edge.txt x
	knowledge_fixture differ-edge.txt y
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 1 ]
	grep -Eq '^same +0\.5 +ok +same-edge\.txt$' <<<"$output"
	grep -Eq '^differ +0\.5 +WRONG +differ-edge\.txt$' <<<"$output"
}

@test "calibrate sends the fixture to decisionkit as it is, with Q_KNOW and KNOW_MIN" {
	calibrate_responder
	knowledge_fixture same-good.txt x
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(cat "$FAKE_DIR/decisionkit.text")" = "$(printf 'A:\nx\nB:\nx\n---')" ]
	[ "$(cat "$FAKE_DIR/decisionkit.argv")" = '<binary><Same facts?><--threshold><0.5><--json><--quiet>' ]
}

@test "calibrate reads only same-*.txt and differ-*.txt files" {
	calibrate_responder
	knowledge_fixture same-good.txt x
	knowledge_fixture other-good.txt x
	knowledge_fixture same-good.md x
	knowledge_fixture sameness.txt x
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 0 ]
	[ "$(grep -c '' "$FAKE_DIR/decisionkit.argv")" -eq 1 ]
}

@test "calibrate exits 2 when the skill has no fixtures" {
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"tests/fixtures/knowledge holds no fixture."* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "calibrate exits 2 when decisionkit fails, and names the fixture" {
	export DK_FAIL=1
	knowledge_fixture same-good.txt x
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"same-good.txt. Run: decisionkit status"* ]] || false
}

@test "calibrate exits 2 when the curator SKILL.md sets no Q_KNOW or KNOW_MIN" {
	calibrate_responder
	knowledge_fixture same-good.txt x
	printf '```sh skill-tests\nQ_KNOW="Same facts?"\n```\n' >"$CURATOR/SKILL.md"
	run "$SCRIPT" calibrate "$DEMO"
	[ "$status" -eq 2 ]
	[[ "$output" == *"must set Q_KNOW and KNOW_MIN."* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "no layer leaves temporary files behind" {
	# macOS mktemp ignores TMPDIR. A fake mktemp puts every temporary folder
	# of the script into the test folder, and the log of the fake counts
	# them.
	mkdir -p "$FAKE_DIR/tmp"
	fake mktemp - <<'EOF'
if [[ "$*" == "-d" ]]; then
	exec /usr/bin/mktemp -d "$FAKE_DIR/tmp/tmp.XXXXXX"
fi
exec /usr/bin/mktemp "$@"
EOF
	fire_responder demo other
	triggers "+ do the demo task"
	run "$SCRIPT" triggers "$DEMO"
	[ "$status" -eq 0 ]
	reader_responder
	export DK_P=0.9
	knowledge "Q: First question?" "A: First fact."
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 0 ]
	score_responder 0.2
	run "$SCRIPT" slop "$DEMO"
	[ "$status" -eq 0 ]
	# A reader that fails leaves nothing either.
	fake claude - <<'EOF'
printf '{"subtype":"error_max_turns"}\n'
exit 1
EOF
	run "$SCRIPT" knowledge "$DEMO"
	[ "$status" -eq 2 ]
	# One folder for each of the four runs, and none is left.
	[ "$(grep -c '^mktemp -d$' "$FAKE_LOG")" -eq 4 ]
	[ -z "$(ls -A "$FAKE_DIR/tmp")" ]
}
