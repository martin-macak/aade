#!/usr/bin/env bash

# Check the cold-reader questions against the fixtures. A fixture must land on
# its expected side, or the question cannot tell good prose from slop.
# The script reads the questions and both thresholds from the block
# "sh questions" in SKILL.md, so the calibrated text is the committed text.
# Paths below are relative to references/fixtures.
#   slop/good/*.txt     Q_SLOP expected value below SLOP_MAX
#   slop/bad/*.txt      Q_SLOP expected value at SLOP_MAX or above
#   match/same-*.txt    Q_MATCH true at MATCH_MIN
#   match/differ-*.txt  Q_MATCH false at MATCH_MIN
# A match file holds the lines "A:" and "B:". It is the Q_MATCH input as is.
# Usage: .agents/skills/cold-reader/scripts/calibrate.sh
# It needs decisionkit and jq on PATH, and a working provider
# (decisionkit status). The fixtures are synthetic text, so sending them is
# fine. Run it again after every change to a question or a fixture.
# Exit codes: 0 every fixture is on its expected side, 1 a fixture is on the
# wrong side, 2 the script cannot run.

set -u -o pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
FIXTURES=$SKILL_DIR/references/fixtures
STATUS=0
GOOD_MAX=""
BAD_MIN=""

# The block holds plain assignments of Q_MATCH, MATCH_MIN, Q_SLOP and SLOP_MAX.
questions=$(awk '/^```sh questions$/ { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL_DIR/SKILL.md")
if [[ -z "$questions" ]]; then
	>&2 echo "SKILL.md has no \"sh questions\" block."
	exit 2
fi
eval "$questions"
if [[ -z "${Q_MATCH:-}" || -z "${MATCH_MIN:-}" || -z "${Q_SLOP:-}" || -z "${SLOP_MAX:-}" ]]; then
	>&2 echo "The \"sh questions\" block must set Q_MATCH, MATCH_MIN, Q_SLOP and SLOP_MAX."
	exit 2
fi

# Succeed when $1 < $2. awk does the float compare, because bash has none.
less_than() {
	awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Keep the lowest ($1 = min) or highest ($1 = max) of the current value $2
# and the new value $3. An empty current value takes the new one.
extreme() {
	if [[ -z "$2" ]]; then
		echo "$3"
	elif [[ "$1" == min ]] && less_than "$3" "$2"; then
		echo "$3"
	elif [[ "$1" == max ]] && less_than "$2" "$3"; then
		echo "$3"
	else
		echo "$2"
	fi
}

# Print the Q_SLOP expected value (0 none, 1 some, 2 heavy) of a file.
slop_value() {
	local json
	json=$(decisionkit score "$Q_SLOP" none some heavy --json --quiet <"$1") || return 1
	jq -er '.answers.q.expected_level' <<<"$json"
}

# Print p_true of Q_MATCH for a file. Exit code 1 of decisionkit only means
# false at the threshold, so the JSON still holds the answer.
match_value() {
	local json rc
	json=$(decisionkit binary "$Q_MATCH" --threshold "$MATCH_MIN" --json --quiet <"$1")
	rc=$?
	((rc <= 1)) || return 1
	jq -er '.answers.q.probability_true' <<<"$json"
}

# Print one result row and mark a wrong side. $1 is the kind, $2 the expected
# side, $3 the value, $4 "yes" when the value is on the expected side, $5 the
# fixture path.
report() {
	local verdict=ok
	if [[ "$4" != yes ]]; then
		verdict=WRONG
		STATUS=1
	fi
	printf '%-6s %-7s %-5s %-6s %s\n' "$1" "$2" "$3" "$verdict" "${5#"$FIXTURES"/}"
}

# Each group needs a fixture, or the run cannot show both sides. Check all
# groups before the first question, so a run fails fast.
for group in slop/good/*.txt slop/bad/*.txt match/same-*.txt match/differ-*.txt; do
	if ! compgen -G "$FIXTURES/$group" >/dev/null; then
		>&2 echo "The fixture group $group is empty. Add a fixture to it."
		exit 2
	fi
done

printf '%-6s %-7s %-5s %-6s %s\n' kind expect value result fixture
for kind in good bad; do
	for file in "$FIXTURES/slop/$kind"/*.txt; do
		if ! value=$(slop_value "$file"); then
			>&2 echo "decisionkit failed on $file. Run: decisionkit status"
			exit 2
		fi
		if less_than "$value" "$SLOP_MAX"; then side=good; else side=bad; fi
		if [[ "$side" == "$kind" ]]; then ok=yes; else ok=no; fi
		report slop "$kind" "$value" "$ok" "$file"
		if [[ "$kind" == good ]]; then
			GOOD_MAX=$(extreme max "$GOOD_MAX" "$value")
		else
			BAD_MIN=$(extreme min "$BAD_MIN" "$value")
		fi
	done
done

for kind in same differ; do
	for file in "$FIXTURES/match/$kind"-*.txt; do
		if ! value=$(match_value "$file"); then
			>&2 echo "decisionkit failed on $file. Run: decisionkit status"
			exit 2
		fi
		if ! less_than "$value" "$MATCH_MIN"; then side=same; else side=differ; fi
		if [[ "$side" == "$kind" ]]; then ok=yes; else ok=no; fi
		report match "$kind" "$value" "$ok" "$file"
	done
done

printf 'Q_SLOP: highest good %s, lowest bad %s, SLOP_MAX %s.\n' "$GOOD_MAX" "$BAD_MIN" "$SLOP_MAX"
exit "$STATUS"
