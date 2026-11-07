#!/usr/bin/env bats

# scripts/calibrate.sh proves that the cold-reader questions can tell good
# prose from slop, and a faithful restatement from a wrong one. Each fixture
# must land on its expected side of a threshold. The script reads the
# questions from SKILL.md, so the calibrated text is the committed text.
# Each test runs a copy of the script in a throwaway skill folder. The shared
# fake decisionkit replaces the real one, so no test calls a provider.

ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	SKILL="$BATS_TEST_TMPDIR/skill"
	FIXTURES="$SKILL/references/fixtures"
	mkdir -p "$SKILL/scripts" "$FIXTURES/slop/good" "$FIXTURES/slop/bad" "$FIXTURES/match"
	cp "$BATS_TEST_DIRNAME/../scripts/calibrate.sh" "$SKILL/scripts/calibrate.sh"
	SCRIPT="$SKILL/scripts/calibrate.sh"
	# The responder reads the value of a fixture from its text: "v=<n>" is
	# the expected level of a score, and the probability of a binary
	# question. The fake exits like the real tool: 0 at or above the
	# threshold, 1 below it. The text "fail" exits 2, and the text "garbage"
	# prints no JSON.
	fake_decisionkit
	dk_responder <<'EOF'
[[ "$text" == *fail* ]] && exit 2
[[ "$text" == *garbage* ]] && {
	echo 'not json'
	exit 0
}
[[ "$text" =~ v=([0-9.]+) ]] || exit 2
DK_P=${BASH_REMATCH[1]} DK_LEVEL=${BASH_REMATCH[1]}
EOF
	skill_md 'Q_MATCH="Same contract?"' 'MATCH_MIN=0.8' 'Q_SLOP="Rate the slop."' 'SLOP_MAX=0.65'
}

# Write SKILL.md with one "sh questions" block. Each argument is a line.
skill_md() {
	{
		printf '# Demo skill\n\nText before the block.\n\n'
		printf '```sh questions\n'
		printf '%s\n' "$@"
		printf '```\n\nText after the block.\n'
	} >"$SKILL/SKILL.md"
}

# Write the fixture $1, relative to the fixtures folder, with the line $2.
fixture() {
	mkdir -p "$(dirname "$FIXTURES/$1")"
	printf '%s\n' "$2" >"$FIXTURES/$1"
}

# Put one fixture of each kind on its expected side.
fixtures_on_the_right_side() {
	fixture slop/good/clear.txt 'v=0.1'
	fixture slop/bad/filler.txt 'v=1.5'
	fixture match/same-limit.txt 'v=0.95'
	fixture match/differ-limit.txt 'v=0.2'
}

@test "passes when every fixture lands on its expected side" {
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"slop   good    0.1   ok     slop/good/clear.txt"* ]] || false
	[[ "$output" == *"slop   bad     1.5   ok     slop/bad/filler.txt"* ]] || false
	[[ "$output" == *"match  same    0.95  ok     match/same-limit.txt"* ]] || false
	[[ "$output" == *"match  differ  0.2   ok     match/differ-limit.txt"* ]] || false
	[[ "$output" != *WRONG* ]] || false
}

@test "prints a header row and then one row for each fixture" {
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "${lines[0]}" = "kind   expect  value result fixture" ]
	# Header, four fixtures and the Q_SLOP summary.
	[ "${#lines[@]}" -eq 6 ]
}

@test "asks decisionkit the questions and the thresholds of the SKILL.md block" {
	skill_md 'Q_MATCH="Does B match A?"' 'MATCH_MIN=0.75' 'Q_SLOP="How much slop?"' 'SLOP_MAX=0.5'
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	grep -qxF '<score><How much slop?><none><some><heavy><--json><--quiet>' "$FAKE_DIR/decisionkit.argv"
	grep -qxF '<binary><Does B match A?><--threshold><0.75><--json><--quiet>' "$FAKE_DIR/decisionkit.argv"
	[[ "$output" == *"SLOP_MAX 0.5."* ]] || false
}

@test "joins a question that continues over several lines" {
	skill_md 'Q_MATCH="Does B \' 'match A?"' 'MATCH_MIN=0.8' 'Q_SLOP="Rate \' 'the slop."' 'SLOP_MAX=0.65'
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	grep -qxF '<score><Rate the slop.><none><some><heavy><--json><--quiet>' "$FAKE_DIR/decisionkit.argv"
	grep -qxF '<binary><Does B match A?><--threshold><0.8><--json><--quiet>' "$FAKE_DIR/decisionkit.argv"
}

@test "sends the fixture text to decisionkit as it is" {
	skill_md 'Q_MATCH="Same?"' 'MATCH_MIN=0.8' 'Q_SLOP="Slop?"' 'SLOP_MAX=0.65'
	printf 'A:\nv=0.95 first line\nB:\nsecond line\n' >"$FIXTURES/match/same-form.txt"
	fixture slop/good/clear.txt 'v=0.1'
	fixture slop/bad/filler.txt 'v=1.5'
	fixture match/differ-limit.txt 'v=0.2'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	grep -qx 'A:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'v=0.95 first line' "$FAKE_DIR/decisionkit.text"
	grep -qx 'B:' "$FAKE_DIR/decisionkit.text"
	grep -qx 'second line' "$FAKE_DIR/decisionkit.text"
}

@test "slop: a good fixture below SLOP_MAX is ok" {
	fixtures_on_the_right_side
	fixture slop/good/almost.txt 'v=0.64'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"slop   good    0.64  ok     slop/good/almost.txt"* ]] || false
}

@test "slop: a good fixture at SLOP_MAX is WRONG, because SLOP_MAX itself is bad" {
	fixtures_on_the_right_side
	fixture slop/good/edge.txt 'v=0.65'
	run "$SCRIPT"
	[ "$status" -eq 1 ]
	[[ "$output" == *"slop   good    0.65  WRONG  slop/good/edge.txt"* ]] || false
}

@test "slop: a bad fixture at SLOP_MAX is ok" {
	fixtures_on_the_right_side
	fixture slop/bad/edge.txt 'v=0.65'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"slop   bad     0.65  ok     slop/bad/edge.txt"* ]] || false
}

@test "slop: a bad fixture below SLOP_MAX is WRONG" {
	fixtures_on_the_right_side
	fixture slop/bad/subtle.txt 'v=0.4'
	run "$SCRIPT"
	[ "$status" -eq 1 ]
	[[ "$output" == *"slop   bad     0.4   WRONG  slop/bad/subtle.txt"* ]] || false
}

@test "match: a same fixture at MATCH_MIN is ok, because MATCH_MIN itself is same" {
	fixtures_on_the_right_side
	fixture match/same-edge.txt 'v=0.8'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"match  same    0.8   ok     match/same-edge.txt"* ]] || false
}

@test "match: a same fixture below MATCH_MIN is WRONG" {
	fixtures_on_the_right_side
	fixture match/same-lossy.txt 'v=0.79'
	run "$SCRIPT"
	[ "$status" -eq 1 ]
	[[ "$output" == *"match  same    0.79  WRONG  match/same-lossy.txt"* ]] || false
}

@test "match: a differ fixture below MATCH_MIN is ok" {
	fixtures_on_the_right_side
	fixture match/differ-edge.txt 'v=0.79'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"match  differ  0.79  ok     match/differ-edge.txt"* ]] || false
}

@test "match: a differ fixture at MATCH_MIN is WRONG" {
	fixtures_on_the_right_side
	fixture match/differ-edge.txt 'v=0.8'
	run "$SCRIPT"
	[ "$status" -eq 1 ]
	[[ "$output" == *"match  differ  0.8   WRONG  match/differ-edge.txt"* ]] || false
}

@test "match: treats exit 1 of decisionkit as false, not as an error" {
	# The fake exits 1 for 0.2, as the real tool does below the threshold.
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"match  differ  0.2   ok"* ]] || false
}

@test "a wrong fixture does not stop the run, so one run shows every problem" {
	fixture slop/good/wrong.txt 'v=1.2'
	fixture slop/good/fine.txt 'v=0.1'
	fixture slop/bad/wrong.txt 'v=0.1'
	fixture slop/bad/fine.txt 'v=1.5'
	fixture match/same-wrong.txt 'v=0.1'
	fixture match/same-fine.txt 'v=0.9'
	fixture match/differ-wrong.txt 'v=0.9'
	fixture match/differ-fine.txt 'v=0.1'
	run "$SCRIPT"
	[ "$status" -eq 1 ]
	[ "$(grep -c ' WRONG ' <<<"$output")" -eq 4 ]
	[ "$(grep -c ' ok ' <<<"$output")" -eq 4 ]
	[[ "$output" == *"Q_SLOP: highest good"* ]] || false
}

@test "prints the highest good and the lowest bad slop value with SLOP_MAX" {
	fixture slop/good/a.txt 'v=0.1'
	fixture slop/good/b.txt 'v=0.45'
	fixture slop/good/c.txt 'v=0.3'
	fixture slop/bad/a.txt 'v=1.8'
	fixture slop/bad/b.txt 'v=0.9'
	fixture slop/bad/c.txt 'v=1.1'
	fixture match/same-x.txt 'v=0.9'
	fixture match/differ-x.txt 'v=0.1'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[ "${lines[${#lines[@]} - 1]}" = "Q_SLOP: highest good 0.45, lowest bad 0.9, SLOP_MAX 0.65." ]
}

@test "compares slop values as numbers, not as text" {
	# As text, "0.9" is above "0.10" and "0.09" is below "0.1".
	fixture slop/good/a.txt 'v=0.10'
	fixture slop/good/b.txt 'v=0.09'
	fixture slop/bad/a.txt 'v=1.5'
	fixture slop/bad/b.txt 'v=0.70'
	fixture match/same-x.txt 'v=0.9'
	fixture match/differ-x.txt 'v=0.1'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[[ "$output" == *"highest good 0.10, lowest bad 0.70,"* ]] || false
}

@test "scores only .txt fixtures in the good, bad, same and differ groups" {
	fixtures_on_the_right_side
	fixture slop/good/notes.md 'v=0.1'
	fixture slop/bad/draft.json 'v=1.5'
	fixture match/other-limit.txt 'v=0.95'
	fixture match/sameness.txt 'v=0.1'
	fixture match/same-limit.md 'v=0.95'
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	[ "$(calls | grep -c '')" -eq 4 ]
}

@test "finds the skill from the script location, not from the working directory" {
	fixtures_on_the_right_side
	cd "$BATS_TEST_TMPDIR"
	run "$SCRIPT"
	[ "$status" -eq 0 ]
	ln -s "$SKILL" "$BATS_TEST_TMPDIR/linked-skill"
	run "$BATS_TEST_TMPDIR/linked-skill/scripts/calibrate.sh"
	[ "$status" -eq 0 ]
	[[ "$output" == *"match/same-limit.txt"* ]] || false
}

@test "exits 2 when SKILL.md has no questions block" {
	printf '# Demo skill\n\nNo block here.\n' >"$SKILL/SKILL.md"
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 2 ]
	[[ "$output" == *'SKILL.md has no "sh questions" block.'* ]] || false
	[ -z "$(calls)" ]
}

@test "exits 2 when SKILL.md is missing" {
	rm "$SKILL/SKILL.md"
	fixtures_on_the_right_side
	run "$SCRIPT"
	[ "$status" -eq 2 ]
	[ -z "$(calls)" ]
}

@test "exits 2 when the questions block misses a variable" {
	fixtures_on_the_right_side
	# Each row: the block, without one of the four variables.
	while IFS='|' read -r a b c; do
		skill_md "$a" "$b" "$c"
		run "$SCRIPT"
		if [[ "$status" -ne 2 || "$output" != *"must set Q_MATCH, MATCH_MIN, Q_SLOP and SLOP_MAX."* ]]; then
			printf 'block: %s %s %s\ngot:   exit %s, %s\n' "$a" "$b" "$c" "$status" "$output"
			return 1
		fi
	done <<'CASES'
MATCH_MIN=0.8|Q_SLOP="Rate."|SLOP_MAX=0.65
Q_MATCH="Same?"|Q_SLOP="Rate."|SLOP_MAX=0.65
Q_MATCH="Same?"|MATCH_MIN=0.8|SLOP_MAX=0.65
Q_MATCH="Same?"|MATCH_MIN=0.8|Q_SLOP="Rate."
CASES
	[ -z "$(calls)" ]
}

@test "exits 2 when decisionkit fails on a slop fixture, and names the fixture" {
	fixtures_on_the_right_side
	fixture slop/bad/broken.txt 'fail'
	run "$SCRIPT"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed on $FIXTURES/slop/bad/broken.txt. Run: decisionkit status"* ]] || false
}

@test "exits 2 when decisionkit fails on a match fixture, and names the fixture" {
	fixtures_on_the_right_side
	fixture match/differ-broken.txt 'fail'
	run "$SCRIPT"
	[ "$status" -eq 2 ]
	[[ "$output" == *"decisionkit failed on $FIXTURES/match/differ-broken.txt. Run: decisionkit status"* ]] || false
}

@test "exits 2 when decisionkit prints no usable answer" {
	fixtures_on_the_right_side
	fixture slop/bad/broken.txt 'garbage'
	run "$SCRIPT"
	[ "$status" -eq 2 ]
	rm "$FIXTURES/slop/bad/broken.txt"
	fixture match/same-broken.txt 'garbage'
	run "$SCRIPT"
	[ "$status" -eq 2 ]
}

@test "exits 2 when a fixture group is empty" {
	fixture slop/good/clear.txt 'v=0.1'
	fixture slop/bad/filler.txt 'v=1.5'
	fixture match/same-limit.txt 'v=0.95'
	run "$SCRIPT"
	[ "$status" -eq 2 ]
}
