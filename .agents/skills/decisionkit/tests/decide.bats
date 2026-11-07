#!/usr/bin/env bats

# Tests for scripts/decide.sh, the decisionkit facade. The shared fake
# decisionkit replaces the real one, so no test calls the provider. The
# facade reads its limits from the real SKILL.md.

ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	SCRIPT="$BATS_TEST_DIRNAME/../scripts/decide.sh"
	# The text "p=<n>" gives a binary answer, and "choice=<option>" a choice
	# answer. Any other text gives the JSON in the file $FAKE_DIR/reply and
	# the exit code FAKE_EXIT.
	fake_decisionkit
	dk_responder <<'EOF'
if [[ "$text" =~ p=([0-9.]+) ]]; then
	DK_P=${BASH_REMATCH[1]}
elif [[ "$text" =~ choice=([a-z]+) ]]; then
	DK_CHOICE=${BASH_REMATCH[1]}
else
	cat "$FAKE_DIR/reply"
	exit "${FAKE_EXIT:-0}"
fi
EOF
	QUESTIONS="$BATS_TEST_TMPDIR/questions.yaml"
	cat >"$QUESTIONS" <<'EOF'
questions:
  - name: Q_BIN
    kind: binary
    text: Is it true?
    threshold: 0.7
  - name: Q_PICK
    kind: choice
    text: Which one?
    options: [alpha, beta]
  - name: Q_LEVEL
    kind: score
    text: How much?
    options: [low, medium, high]
  - name: Q_ORDER
    kind: rank
    text: Which first?
EOF
}

# Print the arguments of the last decisionkit call, one <...> for each.
last_argv() {
	tail -n 1 "$FAKE_DIR/decisionkit.argv"
}

@test "ask prints one JSON line for each kind of question" {
	# Each row: question | candidates | reply | exit code of decisionkit |
	# jq test of the line | exit code of the facade.
	while IFS='|' read -r name candidates reply code check want; do
		printf '%s\n' "$reply" >"$FAKE_DIR/reply"
		# shellcheck disable=SC2086 # the candidates split into words.
		FAKE_EXIT=$code run "$SCRIPT" ask "$QUESTIONS" "$name" --context "some text" $candidates
		if [[ "$status" -ne "$want" ]] || ! jq -e "$check" <<<"$output" >/dev/null; then
			printf 'question: %s\nreply:    %s\nwant:     %s, exit %s\ngot:      %s, exit %s\n' \
				"$name" "$reply" "$check" "$want" "$output" "$status"
			return 1
		fi
	done <<'CASES'
Q_BIN||{"answers":{"q":{"type":"binary","probability_true":0.9}}}|0|.answer == "true" and .p == 0.9 and .threshold == 0.7 and .uncertain == false|0
Q_BIN||{"answers":{"q":{"type":"binary","probability_true":0.6}}}|1|.answer == "false" and .p == 0.6 and .uncertain == true|1
Q_BIN||{"answers":{"q":{"type":"binary","probability_true":0.1}}}|1|.answer == "false" and .uncertain == false|1
Q_PICK||{"answers":{"q":{"type":"choice","choice":"beta","probabilities":{"alpha":0.15,"beta":0.85}}}}|0|.answer == "beta" and .p == 0.85 and .threshold == 0.8 and .uncertain == false|0
Q_PICK||{"answers":{"q":{"type":"choice","choice":"alpha","probabilities":{"alpha":0.55,"beta":0.45}}}}|1|.answer == "alpha" and .uncertain == true|1
Q_LEVEL||{"answers":{"q":{"type":"score","expected_level":1.2,"most_likely":"medium","probabilities":{"low":0.1,"medium":0.6,"high":0.3}}}}|1|.answer == "medium" and .p == 0.6 and .expected == 1.2 and .uncertain == true|1
Q_ORDER|first second third|{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c1","expected_level":3.6},{"candidate_id":"c0","expected_level":3.55},{"candidate_id":"c2","expected_level":1.2}]}}}|0|.answer == ["second","first","third"] and .expected == [3.6,3.55,1.2] and .uncertain == true|0
Q_ORDER|first second|{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c0","expected_level":3.9},{"candidate_id":"c1","expected_level":2.0}]}}}|0|.answer == ["first","second"] and .p == null and .uncertain == false|0
CASES
}

@test "ask hands the question, the options, the threshold and the text to decisionkit" {
	printf '%s\n' '{"answers":{"q":{"type":"choice","choice":"beta","probabilities":{"alpha":0.1,"beta":0.9}}}}' \
		>"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_PICK <<<"text on stdin"
	[ "$status" -eq 0 ]
	[ "$(last_argv)" = '<choice><Which one?><alpha><beta><--threshold><0.8><--json><--quiet>' ]
	[ "$(sed '$d' "$FAKE_DIR/decisionkit.text")" = "text on stdin" ]
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "given text"
	[ "$(last_argv)" = '<binary><Is it true?><--threshold><0.7><--json><--quiet><--context><given text>' ]
}

@test "ask exits 2 for an unknown question, a wrong call or a failed decisionkit" {
	# Each row: arguments after "ask <questions-file>" | exit code of the
	# fake | a fragment of the error.
	while IFS='|' read -r args code expected; do
		printf '{}\n' >"$FAKE_DIR/reply"
		# shellcheck disable=SC2086 # the arguments split into words.
		FAKE_EXIT=$code run "$SCRIPT" ask "$QUESTIONS" $args
		if [[ "$status" -ne 2 || "$output" != *"$expected"* ]]; then
			printf 'args: %s\nwant: exit 2, %s\ngot:  exit %s, %s\n' "$args" "$expected" "$status" "$output"
			return 1
		fi
	done <<'CASES'
Q_NONE --context x|0|No question Q_NONE in
Q_BIN --context x extra|0|Only a rank question takes candidates.
Q_ORDER --context x one|0|A rank question needs at least two candidates.
Q_BIN --context x|2|Run: decisionkit status
CASES
}

@test "calibrate checks each fixture against its label, flags uncertain answers and prints the binary gap" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN" "$fixtures/Q_PICK"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-plain.txt"
	echo 'p=0.75' >"$fixtures/Q_BIN/true-weak.txt"
	echo 'p=0.2' >"$fixtures/Q_BIN/false-wrong.txt"
	echo 'choice=beta' >"$fixtures/Q_PICK/beta-clear.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 0 ]
	[[ "$output" == *"uncertain"*"true-weak.txt"* ]] || false
	[[ "$output" == *"Q_BIN: lowest true 0.75, highest false 0.2"* ]] || false
	[[ "$output" == *"4 fixtures: 3 ok, 1 uncertain, 0 wrong"* ]] || false
	echo 'choice=beta' >"$fixtures/Q_PICK/alpha-miss.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"*"alpha-miss.txt"* ]] || false
	[[ "$output" == *"5 fixtures: 3 ok, 1 uncertain, 1 wrong"* ]] || false
}

@test "calibrate exits 2 without fixtures" {
	mkdir -p "$BATS_TEST_TMPDIR/empty"
	run "$SCRIPT" calibrate "$QUESTIONS" "$BATS_TEST_TMPDIR/empty"
	[ "$status" -eq 2 ]
}

# Copy the script next to a SKILL.md of our own, so that a test sets the
# limits. The text of SKILL.md comes from stdin. COPY is the new script.
copy_with_skill() {
	mkdir -p "$BATS_TEST_TMPDIR/copy/scripts"
	cp "$SCRIPT" "$BATS_TEST_TMPDIR/copy/scripts/decide.sh"
	cat >"$BATS_TEST_TMPDIR/copy/SKILL.md"
	COPY="$BATS_TEST_TMPDIR/copy/scripts/decide.sh"
}

@test "ask prints a single JSON line with the name and the kind of the question" {
	printf '%s\n' '{"answers":{"q":{"type":"binary","probability_true":0.9}}}' >"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "some text"
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -eq 1 ]
	jq -e '.name == "Q_BIN" and .kind == "binary" and .expected == null' <<<"$output"
}

@test "ask prints the same seven fields for every kind of question" {
	# Each row: question | candidates | reply.
	while IFS='|' read -r name candidates reply; do
		printf '%s\n' "$reply" >"$FAKE_DIR/reply"
		# shellcheck disable=SC2086 # the candidates split into words.
		run "$SCRIPT" ask "$QUESTIONS" "$name" --context "some text" $candidates
		if ! jq -e 'keys == ["answer", "expected", "kind", "name", "p", "threshold", "uncertain"]' <<<"$output" >/dev/null; then
			printf 'question: %s\ngot:      exit %s, %s\n' "$name" "$status" "$output"
			return 1
		fi
	done <<'CASES'
Q_BIN||{"answers":{"q":{"type":"binary","probability_true":0.9}}}
Q_PICK||{"answers":{"q":{"type":"choice","choice":"beta","probabilities":{"alpha":0.1,"beta":0.9}}}}
Q_LEVEL||{"answers":{"q":{"type":"score","expected_level":1.9,"most_likely":"high","probabilities":{"low":0,"medium":0.1,"high":0.9}}}}
Q_ORDER|first second|{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c1","expected_level":3.9},{"candidate_id":"c0","expected_level":2.0}]}}}
CASES
}

@test "ask gives no expected level for a binary or a choice question" {
	printf '%s\n' '{"answers":{"q":{"type":"choice","choice":"beta","probabilities":{"alpha":0.1,"beta":0.9}}}}' >"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_PICK --context "some text"
	jq -e '.expected == null' <<<"$output"
	printf '%s\n' '{"answers":{"q":{"type":"binary","probability_true":0.9}}}' >"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "some text"
	jq -e '.expected == null' <<<"$output"
}

@test "ask closes stdin for decisionkit when --context gives the text" {
	# This responder saves what decisionkit could still read from stdin.
	dk_responder <<'EOF'
cat >"$FAKE_DIR/stdin"
EOF
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "given text" <<<"text on stdin"
	[ "$status" -eq 0 ]
	[ ! -s "$FAKE_DIR/stdin" ]
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN <<<"text on stdin"
	[ "$status" -eq 0 ]
	grep -qx 'text on stdin' "$FAKE_DIR/decisionkit.text"
}

@test "ask sends the text of --context and does not read stdin" {
	printf '%s\n' '{"answers":{"q":{"type":"binary","probability_true":0.9}}}' >"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "text from the option" <<<"text on stdin"
	[ "$status" -eq 0 ]
	[ "$(sed '$d' "$FAKE_DIR/decisionkit.text")" = "text from the option" ]
}

@test "ask decides a binary question at 0.5 when it sets no threshold" {
	cat >>"$QUESTIONS" <<'EOF'
  - name: Q_PLAIN
    kind: binary
    text: Is it plain?
EOF
	run "$SCRIPT" ask "$QUESTIONS" Q_PLAIN --context "p=0.5"
	[ "$status" -eq 0 ]
	jq -e '.answer == "true" and .threshold == 0.5' <<<"$output"
	[ "$(last_argv)" = '<binary><Is it plain?><--threshold><0.5><--json><--quiet><--context><p=0.5>' ]
}

@test "ask decides a score question at UNCERTAIN_MIN when it sets no threshold" {
	printf '%s\n' '{"answers":{"q":{"type":"score","expected_level":1.9,"most_likely":"high","probabilities":{"low":0,"medium":0.1,"high":0.9}}}}' \
		>"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_LEVEL --context "some text"
	[ "$status" -eq 0 ]
	jq -e '.answer == "high" and .threshold == 0.8 and .uncertain == false' <<<"$output"
	[ "$(last_argv)" = '<score><How much?><low><medium><high><--threshold><0.8><--json><--quiet><--context><some text>' ]
}

@test "ask hands a rank question to decisionkit with its candidates and no threshold" {
	printf '%s\n' '{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c1","expected_level":3.9},{"candidate_id":"c0","expected_level":2.0}]}}}' \
		>"$FAKE_DIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_ORDER --context "which?" "fix the bug" "write docs"
	[ "$status" -eq 0 ]
	[ "$(last_argv)" = '<rank><Which first?><fix the bug><write docs><--json><--quiet><--context><which?>' ]
	jq -e '.threshold == null and .answer == ["write docs", "fix the bug"]' <<<"$output"
}

@test "ask keeps an option with spaces whole" {
	cat >>"$QUESTIONS" <<'EOF'
  - name: Q_SPACE
    kind: choice
    text: Which state?
    options: [needs work, done]
EOF
	run "$SCRIPT" ask "$QUESTIONS" Q_SPACE --context "choice=done"
	[ "$status" -eq 0 ]
	[ "$(last_argv)" = '<choice><Which state?><needs work><done><--threshold><0.8><--json><--quiet><--context><choice=done>' ]
}

@test "ask exits 2 when the questions file is missing" {
	run "$SCRIPT" ask "$BATS_TEST_TMPDIR/none.yaml" Q_BIN --context "some text"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Missing questions file $BATS_TEST_TMPDIR/none.yaml."* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "ask exits 2 for a question with an unknown kind" {
	cat >>"$QUESTIONS" <<'EOF'
  - name: Q_ODD
    kind: poll
    text: Which poll?
EOF
	run "$SCRIPT" ask "$QUESTIONS" Q_ODD --context "some text"
	[ "$status" -eq 2 ]
	[[ "$output" == *"The question Q_ODD has the unknown kind poll."* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "ask exits 2 for a rank question without candidates" {
	run "$SCRIPT" ask "$QUESTIONS" Q_ORDER --context "some text"
	[ "$status" -eq 2 ]
	[[ "$output" == *"A rank question needs at least two candidates."* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "ask exits 2 when decisionkit exits 0 without an answer" {
	# Each row: what the fake prints.
	while IFS= read -r reply; do
		printf '%s\n' "$reply" >"$FAKE_DIR/reply"
		run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "some text"
		if [[ "$status" -ne 2 || "$output" != *"decisionkit failed on Q_BIN. Run: decisionkit status"* ]]; then
			printf 'reply: %s\ngot:   exit %s, %s\n' "$reply" "$status" "$output"
			return 1
		fi
	done <<'CASES'
{}
{"answers":{}}
not json at all
CASES
}

@test "ask exits 2 when decisionkit exits 2, even if it printed an answer" {
	printf '%s\n' '{"answers":{"q":{"type":"binary","probability_true":0.9}}}' >"$FAKE_DIR/reply"
	FAKE_EXIT=2 run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "some text"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed on Q_BIN. Run: decisionkit status"* ]] || false
	[[ "$output" != *'"answer"'* ]] || false
}

@test "the facade shows its usage and exits 2 for a call that it does not know" {
	# Each row: the arguments. An empty row is a call without arguments.
	while IFS= read -r args; do
		# shellcheck disable=SC2086 # the arguments split into words.
		run "$SCRIPT" $args
		if [[ "$status" -ne 2 || "$output" != *"Usage: "*"ask <questions-file> <name>"* || "$output" != *"calibrate <questions-file> <fixtures-dir>"* ]]; then
			printf 'args: %s\ngot:  exit %s, %s\n' "$args" "$status" "$output"
			return 1
		fi
	done <<CASES

nope
nope $QUESTIONS Q_BIN
ask
ask $QUESTIONS
calibrate
calibrate $QUESTIONS
calibrate $QUESTIONS $BATS_TEST_TMPDIR $BATS_TEST_TMPDIR
CASES
}

@test "ask exits 2 when --context has no text" {
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage: "* ]] || false
	[ ! -e "$FAKE_DIR/decisionkit.argv" ]
}

@test "the limits come from the facade block of SKILL.md" {
	copy_with_skill <<'EOF'
# Demo skill

```sh facade
UNCERTAIN_MIN=0.95
RANK_TIE=0.01
```
EOF
	printf '%s\n' '{"answers":{"q":{"type":"choice","choice":"beta","probabilities":{"alpha":0.1,"beta":0.9}}}}' \
		>"$FAKE_DIR/reply"
	run "$COPY" ask "$QUESTIONS" Q_PICK --context "some text"
	[ "$status" -eq 0 ]
	jq -e '.threshold == 0.95 and .uncertain == true' <<<"$output"
	# The gap of 0.05 is above RANK_TIE here, and below the 0.1 of the real block.
	printf '%s\n' '{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c1","expected_level":3.6},{"candidate_id":"c0","expected_level":3.55}]}}}' \
		>"$FAKE_DIR/reply"
	run "$COPY" ask "$QUESTIONS" Q_ORDER --context "some text" first second
	[ "$status" -eq 0 ]
	jq -e '.uncertain == false' <<<"$output"
}

@test "a rank answer is uncertain when the top two differ by less than RANK_TIE" {
	copy_with_skill <<'EOF'
# Demo skill

```sh facade
UNCERTAIN_MIN=0.8
RANK_TIE=0.5
```
EOF
	# Each row: the levels of the top two | uncertain.
	while IFS='|' read -r top second want; do
		printf '{"answers":{"q":{"type":"rank","ranking":[{"candidate_id":"c1","expected_level":%s},{"candidate_id":"c0","expected_level":%s}]}}}\n' \
			"$top" "$second" >"$FAKE_DIR/reply"
		run "$COPY" ask "$QUESTIONS" Q_ORDER --context "some text" first second
		if [[ "$status" -ne 0 ]] || ! jq -e ".uncertain == $want" <<<"$output" >/dev/null; then
			printf 'levels: %s and %s\nwant:   uncertain %s\ngot:    exit %s, %s\n' "$top" "$second" "$want" "$status" "$output"
			return 1
		fi
	done <<'CASES'
3.5|3.0|false
3.5|3.25|true
3.5|3.5|true
CASES
}

@test "exits 2 when the facade block misses UNCERTAIN_MIN or RANK_TIE" {
	# Each row: the lines of SKILL.md, with | for a line break.
	while IFS= read -r skill; do
		copy_with_skill <<<"${skill//|/$'\n'}"
		run "$COPY" ask "$QUESTIONS" Q_BIN --context "some text"
		if [[ "$status" -ne 2 || "$output" != *'must set UNCERTAIN_MIN and RANK_TIE.'* || -e "$FAKE_DIR/decisionkit.argv" ]]; then
			printf 'SKILL.md: %s\ngot:      exit %s, %s\n' "$skill" "$status" "$output"
			return 1
		fi
	done <<'CASES'
# A skill without a block.
```sh facade|RANK_TIE=0.1|```
```sh facade|UNCERTAIN_MIN=0.8|```
```sh other|UNCERTAIN_MIN=0.8|RANK_TIE=0.1|```
CASES
}

@test "calibrate shows a header and one row for each fixture" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-plain.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 0 ]
	[ "${lines[0]}" = "question       want     got      p      result    fixture" ]
	[ "${lines[1]}" = "Q_BIN          true     true     0.95   ok        true-plain.txt" ]
}

@test "calibrate skips rank questions, because no label can state a ranking" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN" "$fixtures/Q_ORDER"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-plain.txt"
	echo 'p=0.95' >"$fixtures/Q_ORDER/first-plain.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 0 ]
	[[ "$output" == *"1 fixtures: 1 ok, 0 uncertain, 0 wrong"* ]] || false
	[[ "$output" != *Q_ORDER* ]] || false
}

@test "calibrate reads only files that are named <label>-<name>.txt" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_PICK"
	echo 'choice=beta' >"$fixtures/Q_PICK/beta-two-words.txt"
	echo 'choice=beta' >"$fixtures/Q_PICK/notes.txt"
	echo 'choice=beta' >"$fixtures/Q_PICK/beta-draft.md"
	echo 'choice=alpha' >"$fixtures/Q_PICK/alpha.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 0 ]
	[[ "$output" == *"1 fixtures: 1 ok, 0 uncertain, 0 wrong"* ]] || false
	[[ "$output" == *"beta     beta"*"beta-two-words.txt"* ]] || false
}

@test "calibrate prints none for the missing side of a binary gap" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-plain.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[[ "$output" == *"Q_BIN: lowest true 0.95, highest false none"* ]] || false
	rm "$fixtures/Q_BIN/true-plain.txt"
	echo 'p=0.2' >"$fixtures/Q_BIN/false-plain.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[[ "$output" == *"Q_BIN: lowest true none, highest false 0.2"* ]] || false
}

@test "calibrate keeps the lowest true and the highest false answer of a binary question" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-a.txt"
	echo 'p=0.9' >"$fixtures/Q_BIN/true-b.txt"
	echo 'p=0.99' >"$fixtures/Q_BIN/true-c.txt"
	echo 'p=0.3' >"$fixtures/Q_BIN/false-a.txt"
	echo 'p=0.1' >"$fixtures/Q_BIN/false-b.txt"
	echo 'p=0.2' >"$fixtures/Q_BIN/false-c.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 0 ]
	[[ "$output" == *"Q_BIN: lowest true 0.9, highest false 0.3"* ]] || false
}

@test "calibrate exits 2 when decisionkit fails on a fixture" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN"
	echo 'no value in this text' >"$fixtures/Q_BIN/true-broken.txt"
	printf '{}\n' >"$FAKE_DIR/reply"
	FAKE_EXIT=2 run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed on Q_BIN. Run: decisionkit status"* ]] || false
	[[ "$output" != *fixtures:* ]] || false
}

@test "calibrate exits 2 when the fixtures folder does not exist" {
	run "$SCRIPT" calibrate "$QUESTIONS" "$BATS_TEST_TMPDIR/none"
	[ "$status" -eq 2 ]
	[[ "$output" == *"$BATS_TEST_TMPDIR/none holds no fixture."* ]] || false
}

@test "calibrate exits 2 when the questions file is missing" {
	fixtures="$BATS_TEST_TMPDIR/fixtures"
	mkdir -p "$fixtures/Q_BIN"
	echo 'p=0.95' >"$fixtures/Q_BIN/true-plain.txt"
	run "$SCRIPT" calibrate "$BATS_TEST_TMPDIR/none.yaml" "$fixtures"
	[ "$status" -eq 2 ]
}
