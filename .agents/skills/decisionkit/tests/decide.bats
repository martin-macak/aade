#!/usr/bin/env bats

# Tests for scripts/decide.sh, the decisionkit facade. A fake decisionkit
# replaces the real one, so no test calls the provider. The facade reads its
# limits from the real SKILL.md.

setup() {
	SCRIPT="$BATS_TEST_DIRNAME/../scripts/decide.sh"
	BIN="$BATS_TEST_TMPDIR/bin"
	mkdir -p "$BIN"
	# The fake logs each argument on a line, and the text it got. The text
	# "p=<n>" gives a binary answer, and "choice=<option>" a choice answer.
	# Any other text gives the JSON in the file reply and exit code
	# FAKE_EXIT.
	cat >"$BIN/decisionkit" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >"$BATS_TEST_TMPDIR/args"
text=""
prev=""
for arg in "\$@"; do
	[[ "\$prev" == --context ]] && text=\$arg
	prev=\$arg
done
[[ " \$* " == *" --context "* ]] || text=\$(cat)
printf '%s' "\$text" >"$BATS_TEST_TMPDIR/text"
if [[ "\$text" =~ p=([0-9.]+) ]]; then
	printf '{"answers":{"q":{"type":"binary","probability_true":%s}}}\n' "\${BASH_REMATCH[1]}"
	exit 0
fi
if [[ "\$text" =~ choice=([a-z]+) ]]; then
	printf '{"answers":{"q":{"type":"choice","choice":"%s","probabilities":{"%s":0.9}}}}\n' "\${BASH_REMATCH[1]}" "\${BASH_REMATCH[1]}"
	exit 0
fi
cat "$BATS_TEST_TMPDIR/reply"
exit \${FAKE_EXIT:-0}
STUB
	chmod +x "$BIN/decisionkit"
	PATH="$BIN:$PATH"
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

@test "ask prints one JSON line for each kind of question" {
	# Each row: question | candidates | reply | exit code of decisionkit |
	# jq test of the line | exit code of the facade.
	while IFS='|' read -r name candidates reply code check want; do
		printf '%s\n' "$reply" >"$BATS_TEST_TMPDIR/reply"
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
		>"$BATS_TEST_TMPDIR/reply"
	run "$SCRIPT" ask "$QUESTIONS" Q_PICK <<<"text on stdin"
	[ "$status" -eq 0 ]
	[ "$(cat "$BATS_TEST_TMPDIR/args")" = "$(printf '%s\n' choice 'Which one?' alpha beta --threshold 0.8 --json --quiet)" ]
	[ "$(cat "$BATS_TEST_TMPDIR/text")" = "text on stdin" ]
	run "$SCRIPT" ask "$QUESTIONS" Q_BIN --context "given text"
	[ "$(cat "$BATS_TEST_TMPDIR/args")" = "$(printf '%s\n' binary 'Is it true?' --threshold 0.7 --json --quiet --context 'given text')" ]
}

@test "ask exits 2 for an unknown question, a wrong call or a failed decisionkit" {
	# Each row: arguments after "ask <questions-file>" | exit code of the
	# fake | a fragment of the error.
	while IFS='|' read -r args code expected; do
		printf '{}\n' >"$BATS_TEST_TMPDIR/reply"
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
	[[ "$output" == *"uncertain"*"true-weak.txt"* ]]
	[[ "$output" == *"Q_BIN: lowest true 0.75, highest false 0.2"* ]]
	[[ "$output" == *"4 fixtures: 3 ok, 1 uncertain, 0 wrong"* ]]
	echo 'choice=beta' >"$fixtures/Q_PICK/alpha-miss.txt"
	run "$SCRIPT" calibrate "$QUESTIONS" "$fixtures"
	[ "$status" -eq 1 ]
	[[ "$output" == *"WRONG"*"alpha-miss.txt"* ]]
	[[ "$output" == *"5 fixtures: 3 ok, 1 uncertain, 1 wrong"* ]]
}

@test "calibrate exits 2 without fixtures" {
	mkdir -p "$BATS_TEST_TMPDIR/empty"
	run "$SCRIPT" calibrate "$QUESTIONS" "$BATS_TEST_TMPDIR/empty"
	[ "$status" -eq 2 ]
}
