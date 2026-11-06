#!/usr/bin/env bash

# Test one skill. The knowledge-curator skill explains each layer in the
# section "Test a skill".
# Usage: test-skill.sh <layer> <skill-dir>
#   drift      bats on <skill-dir>/tests/*.bats. No LLM.
#   triggers   Claude headless loads the skill for each "+" task in
#              tests/triggers.txt, and not for each "-" task. A user-only
#              skill, which no model can load, is skipped.
#   knowledge  A headless cold reader answers tests/knowledge.txt from
#              SKILL.md alone. decisionkit grades each answer with Q_KNOW.
#   slop       decisionkit scores each "## " section of SKILL.md with Q_SLOP.
#   calibrate  decisionkit scores the Q_KNOW pairs in
#              tests/fixtures/knowledge. Only knowledge-curator has them.
# Environment: SKILL_TEST_MODEL (default haiku), SKILL_TEST_RUNS (default 3)
# and SKILL_TEST_JOBS (default 4).
# It needs bats and jq, claude for triggers and knowledge, and decisionkit
# for knowledge, slop and calibrate. The skill Makefile runs it through
# mise exec, so the pinned versions apply. It runs on bash 3.2.
# Exit codes: 0 pass, 1 a case failed, 2 the layer cannot run.

set -u -o pipefail

CURATOR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
SELF=$CURATOR_DIR/scripts/$(basename "${BASH_SOURCE[0]}")
COLD_READER=$CURATOR_DIR/../cold-reader/SKILL.md
MODEL=${SKILL_TEST_MODEL:-haiku}
RUNS=${SKILL_TEST_RUNS:-3}
JOBS=${SKILL_TEST_JOBS:-4}
# Scores drift between runs by up to 0.1. A slop score this close to
# SLOP_MAX prints WARN, so a section does not fail by surprise next week.
SLOP_DRIFT=0.1
# The cold reader answers in this form. Each answer keeps its question number.
ANSWER_SCHEMA='{"type":"object","properties":{"answers":{"type":"array","items":{"type":"object","properties":{"n":{"type":"integer"},"answer":{"type":"string"}},"required":["n","answer"]}}},"required":["answers"]}'

usage() {
	>&2 echo "Usage: $0 drift|triggers|knowledge|slop|calibrate <skill-dir>"
	exit 2
}

# Print the lines of the fenced block "```sh <tag>" in a Markdown file.
read_block() {
	awk -v open="\`\`\`sh $2" '$0 == open { inside = 1; next } inside && /^```$/ { exit } inside' "$1"
}

# Print the front matter of a Markdown file.
front_matter() {
	awk 'NR == 1 && /^---$/ { inside = 1; next } inside && /^---$/ { exit } inside' "$1"
}

# Succeed when $1 < $2. awk does the float compare, because bash has none.
less_than() {
	awk -v a="$1" -v b="$2" 'BEGIN { exit !(a < b) }'
}

# Shorten a line for a result row.
clip() {
	if ((${#1} > 70)); then
		printf '%s...' "${1:0:67}"
	else
		printf '%s' "$1"
	fi
}

layer_drift() {
	if ! compgen -G "$SKILL_DIR/tests/*.bats" >/dev/null; then
		>&2 echo "$SKILL_DIR/tests holds no .bats file."
		return 2
	fi
	bats "$SKILL_DIR/tests"
}

# One headless run for one task. $1 is the file with the task, $2 the file
# that gets the result: the loaded skills, one per line, or ERROR.
# --tools Skill offers only the Skill tool. One turn is enough to see the
# first tool call. claude then exits 1 with error_max_turns, which is normal.
fire_once() {
	local out subtype
	out=$(cd "$ROOT" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p \
		--model "$MODEL" --tools Skill --setting-sources project \
		--strict-mcp-config --no-session-persistence --max-turns 1 \
		--output-format stream-json --verbose "$(cat "$1")" 2>/dev/null)
	subtype=$(jq -r 'select(.type == "result") | .subtype' <<<"$out" 2>/dev/null)
	case $subtype in
	success | error_max_turns)
		# A plugin skill has the form plugin:name. Keep the name.
		jq -r 'select(.type == "assistant") | .message.content[]?
			| select(.type == "tool_use" and .name == "Skill")
			| .input.skill | sub("^.*:"; "")' <<<"$out" >"$2" || echo ERROR >"$2"
		;;
	*) echo ERROR >"$2" ;;
	esac
}

layer_triggers() {
	local file=$SKILL_DIR/tests/triggers.txt tmp line n=0 i r sign task fired want verdict errors=0
	# A user-only skill sets disable-model-invocation: true. No model can load
	# it, so a trigger case cannot test it.
	if front_matter "$SKILL_DIR/SKILL.md" | grep -qE '^disable-model-invocation: *true *$'; then
		echo "skip: $SKILL is a user-only skill. No model can load it."
		return 0
	fi
	[[ -f "$file" ]] || {
		>&2 echo "Missing $file."
		return 2
	}
	tmp=$(mktemp -d) || return 2
	local signs=() tasks=()
	while IFS= read -r line || [[ -n "$line" ]]; do
		case $line in
		'' | '#'*) continue ;;
		'+ '* | '- '*)
			signs+=("${line:0:1}")
			tasks+=("${line:2}")
			printf '%s' "${line:2}" >"$tmp/$n.task"
			n=$((n + 1))
			;;
		*)
			>&2 echo "$file: a line must start with \"+ \", \"- \" or \"#\": $line"
			rm -rf "$tmp"
			return 2
			;;
		esac
	done <"$file"
	if ((n == 0)); then
		>&2 echo "$file holds no task."
		rm -rf "$tmp"
		return 2
	fi
	# The xargs children read ROOT. MODEL comes from SKILL_TEST_MODEL again.
	export ROOT
	for ((i = 0; i < n; i++)); do
		for ((r = 0; r < RUNS; r++)); do
			printf '%s\0%s\0' "$tmp/$i.task" "$tmp/$i.$r.out"
		done
	done | xargs -0 -n 2 -P "$JOBS" "$SELF" _fire
	printf '%-4s %-5s %-5s %-6s %s\n' case want fired result task
	for ((i = 0; i < n; i++)); do
		sign=${signs[i]}
		task=${tasks[i]}
		fired=0
		for ((r = 0; r < RUNS; r++)); do
			if [[ ! -f "$tmp/$i.$r.out" ]] || grep -qx ERROR "$tmp/$i.$r.out"; then
				errors=$((errors + 1))
			elif grep -qxF "$SKILL" "$tmp/$i.$r.out"; then
				fired=$((fired + 1))
			fi
		done
		# The majority of the runs decides.
		want=fire
		[[ "$sign" == - ]] && want=quiet
		if { [[ "$want" == fire ]] && ((fired * 2 > RUNS)); } ||
			{ [[ "$want" == quiet ]] && ((fired * 2 < RUNS)); }; then
			verdict=ok
		else
			verdict=WRONG
			STATUS=1
		fi
		printf '%-4s %-5s %-5s %-6s %s\n' "$sign" "$want" "$fired/$RUNS" "$verdict" "$(clip "$task")"
		# A wrong case shows what the runs loaded, to guide the fix.
		if [[ "$verdict" == WRONG ]]; then
			printf '      loaded: %s\n' "$(cat "$tmp/$i".*.out 2>/dev/null | grep -vx ERROR | sort | uniq -c |
				awk '{ printf "%s%s (%d)", sep, $2, $1; sep = ", " } END { if (!NR) printf "no skill" }')"
		fi
	done
	rm -rf "$tmp"
	if ((errors > 0)); then
		>&2 echo "$errors headless runs failed. Check that claude works: claude -p hello"
		return 2
	fi
	return "$STATUS"
}

# Load Q_KNOW and KNOW_MIN from the block "sh skill-tests" of this skill.
load_know() {
	eval "$(read_block "$CURATOR_DIR/SKILL.md" skill-tests)"
	if [[ -z "${Q_KNOW:-}" || -z "${KNOW_MIN:-}" ]]; then
		>&2 echo "The \"sh skill-tests\" block in $CURATOR_DIR/SKILL.md must set Q_KNOW and KNOW_MIN."
		return 2
	fi
}

# Print p_true of Q_KNOW for an "A:"/"B:" text on stdin. Exit code 1 of
# decisionkit only means false at the threshold, so the JSON still holds it.
know_value() {
	local json rc
	json=$(decisionkit binary "$Q_KNOW" --threshold "$KNOW_MIN" --json --quiet)
	rc=$?
	((rc <= 1)) || return 1
	jq -er '.answers.q.probability_true' <<<"$json"
}

layer_knowledge() {
	local file=$SKILL_DIR/tests/knowledge.txt line question="" n=0 i prompt reader_dir json answer value
	local questions=() expected=()
	[[ -f "$file" ]] || {
		>&2 echo "Missing $file."
		return 2
	}
	load_know || return 2
	while IFS= read -r line || [[ -n "$line" ]]; do
		case $line in
		'' | '#'*) continue ;;
		'Q: '*)
			if [[ -n "$question" ]]; then
				>&2 echo "$file: the question \"$question\" has no \"A: \" line."
				return 2
			fi
			question=${line:3}
			;;
		'A: '*)
			if [[ -z "$question" ]]; then
				>&2 echo "$file: an \"A: \" line has no question before it."
				return 2
			fi
			questions+=("$question")
			expected+=("${line:3}")
			question=""
			n=$((n + 1))
			;;
		*)
			>&2 echo "$file: a line must start with \"Q: \", \"A: \" or \"#\": $line"
			return 2
			;;
		esac
	done <"$file"
	if [[ -n "$question" ]]; then
		>&2 echo "$file: the question \"$question\" has no \"A: \" line."
		return 2
	fi
	if ((n == 0)); then
		>&2 echo "$file holds no question."
		return 2
	fi
	prompt=$({
		printf 'You are a cold reader. Below is the only document you can see.\n'
		printf 'Answer each numbered question from the document alone, in one to\n'
		printf 'three sentences. Keep every value, path and command as the document\n'
		printf 'states it. If the document does not answer a question, answer\n'
		printf '"not stated".\n\n<document path="%s">\n' "${SKILL_DIR#"$ROOT"/}/SKILL.md"
		cat "$SKILL_DIR/SKILL.md"
		printf '</document>\n\n'
		for ((i = 0; i < n; i++)); do
			printf '%d. %s\n' "$((i + 1))" "${questions[i]}"
		done
	})
	# An empty directory and these flags keep out project rules, tools,
	# skills and memory, as the cold-reader skill requires.
	reader_dir=$(mktemp -d) || return 2
	json=$(cd "$reader_dir" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p \
		--model "$MODEL" --tools "" --setting-sources "" --disable-slash-commands \
		--strict-mcp-config --no-session-persistence --output-format json \
		--json-schema "$ANSWER_SCHEMA" <<<"$prompt" 2>/dev/null)
	rm -rf "$reader_dir"
	if ! jq -e '.subtype == "success" and (.structured_output.answers | type) == "array"' <<<"$json" >/dev/null 2>&1; then
		>&2 echo "The cold reader gave no answers. Check that claude works: claude -p hello"
		return 2
	fi
	printf '%-5s %-6s %s\n' p result question
	for ((i = 0; i < n; i++)); do
		answer=$(jq -r --argjson n "$((i + 1))" '[.structured_output.answers[] | select(.n == $n) | .answer][0] // "not stated"' <<<"$json")
		if ! value=$(printf 'A:\n%s\nB:\n%s\n' "${expected[i]}" "$answer" | know_value); then
			>&2 echo "decisionkit failed. Run: decisionkit status"
			return 2
		fi
		if less_than "$value" "$KNOW_MIN"; then
			STATUS=1
			printf '%-5s %-6s %s\n' "$value" WRONG "$(clip "${questions[i]}")"
			printf '      expected: %s\n      answer:   %s\n' "${expected[i]}" "$answer"
		else
			printf '%-5s %-6s %s\n' "$value" ok "$(clip "${questions[i]}")"
		fi
	done
	return "$STATUS"
}

layer_slop() {
	local tmp section heading json value verdict
	eval "$(read_block "$COLD_READER" questions)"
	if [[ -z "${Q_SLOP:-}" || -z "${SLOP_MAX:-}" ]]; then
		>&2 echo "The \"sh questions\" block in $COLD_READER must set Q_SLOP and SLOP_MAX."
		return 2
	fi
	tmp=$(mktemp -d) || return 2
	# Skip the front matter. The text before the first "## " is section 000.
	awk -v dir="$tmp" '
		NR == 1 && /^---$/ { front = 1; next }
		front && /^---$/ { front = 0; next }
		front { next }
		/^## / { n++ }
		{ file = sprintf("%s/%03d.md", dir, n); print > file }
	' "$SKILL_DIR/SKILL.md"
	printf '%-5s %-6s %s\n' value result section
	for section in "$tmp"/*.md; do
		# A section of blank lines only has nothing to score.
		grep -q '[^[:space:]]' "$section" || continue
		heading=$(grep -m 1 '^## ' "$section" || echo "(before the first ## heading)")
		if ! json=$(decisionkit score "$Q_SLOP" none some heavy --json --quiet <"$section") ||
			! value=$(jq -er '.answers.q.expected_level' <<<"$json"); then
			>&2 echo "decisionkit failed. Run: decisionkit status"
			rm -rf "$tmp"
			return 2
		fi
		if ! less_than "$value" "$SLOP_MAX"; then
			verdict=WRONG
			STATUS=1
		elif ! less_than "$value" "$(awk -v m="$SLOP_MAX" -v d="$SLOP_DRIFT" 'BEGIN { print m - d }')"; then
			verdict=WARN
		else
			verdict=ok
		fi
		printf '%-5s %-6s %s\n' "$value" "$verdict" "$(clip "$heading")"
	done
	rm -rf "$tmp"
	return "$STATUS"
}

layer_calibrate() {
	local dir=$SKILL_DIR/tests/fixtures/knowledge file kind value ok
	load_know || return 2
	if ! compgen -G "$dir/*.txt" >/dev/null; then
		>&2 echo "$dir holds no fixture."
		return 2
	fi
	printf '%-6s %-5s %-6s %s\n' want p result fixture
	for kind in same differ; do
		for file in "$dir/$kind"-*.txt; do
			[[ -f "$file" ]] || continue
			if ! value=$(know_value <"$file"); then
				>&2 echo "decisionkit failed on $file. Run: decisionkit status"
				return 2
			fi
			if less_than "$value" "$KNOW_MIN"; then ok=differ; else ok=same; fi
			if [[ "$ok" == "$kind" ]]; then
				printf '%-6s %-5s %-6s %s\n' "$kind" "$value" ok "$(basename "$file")"
			else
				STATUS=1
				printf '%-6s %-5s %-6s %s\n' "$kind" "$value" WRONG "$(basename "$file")"
			fi
		done
	done
	return "$STATUS"
}

# xargs calls the script again for each headless run.
if [[ "${1:-}" == _fire ]]; then
	(($# == 3)) || exit 2
	fire_once "$2" "$3"
	exit 0
fi

(($# == 2)) || usage
[[ -d "$2" ]] || usage
# -P resolves the .claude/skills symlink to the .agents/skills folder.
SKILL_DIR=$(cd "$2" && pwd -P) || exit 2
SKILL=$(basename "$SKILL_DIR")
# A skill folder is .agents/skills/<name>. git is not asked, because a
# commit hook can export GIT_DIR, and git then reports the wrong root.
ROOT=$(cd "$SKILL_DIR/../../.." && pwd) || exit 2
STATUS=0

case $1 in
drift) layer_drift ;;
triggers) layer_triggers ;;
knowledge) layer_knowledge ;;
slop) layer_slop ;;
calibrate) layer_calibrate ;;
*) usage ;;
esac
