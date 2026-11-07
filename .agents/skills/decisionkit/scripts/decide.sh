#!/usr/bin/env bash

# The decisionkit facade. It asks a closed question from a questions file,
# so every caller uses the same question, options, threshold and output.
# The decisionkit skill explains it in the section "Facade".
# Usage: decide.sh ask <questions-file> <name> [--context <text>] [<candidate>...]
#        decide.sh calibrate <questions-file> <fixtures-dir>
# ask reads the text on stdin, unless --context gives it. Only a rank
# question takes candidates, at least two. It prints one JSON line with
# name, kind, answer, p, expected, threshold and uncertain.
# calibrate scores each <fixtures-dir>/<name>/<label>-*.txt. The label is
# the answer that the fixture expects. A fixture that gets its label from
# an uncertain answer is marked uncertain. The last line counts the ok,
# uncertain and wrong fixtures.
# It reads UNCERTAIN_MIN and RANK_TIE from the block "sh facade" of the
# skill. It needs decisionkit, jq and yq, and runs on bash 3.2.
# Exit codes: 0 true or confident, 1 false or below the threshold, 2 error.

set -u -o pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2

usage() {
	>&2 echo "Usage: $0 ask <questions-file> <name> [--context <text>] [<candidate>...]"
	>&2 echo "       $0 calibrate <questions-file> <fixtures-dir>"
	exit 2
}

# Set UNCERTAIN_MIN and RANK_TIE from the block "sh facade" of SKILL.md.
load_limits() {
	eval "$(awk '$0 == "```sh facade" { inside = 1; next } inside && /^```$/ { exit } inside' "$SKILL_DIR/SKILL.md")"
	if [[ -z "${UNCERTAIN_MIN:-}" || -z "${RANK_TIE:-}" ]]; then
		>&2 echo "The \"sh facade\" block in $SKILL_DIR/SKILL.md must set UNCERTAIN_MIN and RANK_TIE."
		exit 2
	fi
}

# Print the field $3 of the question $2 in the questions file $1. Print
# nothing when the question or the field is missing.
field() {
	NAME=$2 yq -r '.questions[] | select(.name == strenv(NAME)) | .'"$3"' // ""' "$1"
}

# Ask the question $2 of the questions file $1, and print the JSON line.
# The remaining arguments are an optional --context <text> and, for a rank
# question, the candidates. Return the exit code of decisionkit.
ask() {
	local file=$1 name=$2 kind text threshold json rc option context="" has_context=0
	local options=() candidates=() args=()
	shift 2
	if [[ "${1:-}" == --context ]]; then
		(($# >= 2)) || usage
		context=$2
		has_context=1
		shift 2
	fi
	if (($# > 0)); then
		candidates=("$@")
	fi
	[[ -f "$file" ]] || {
		>&2 echo "Missing questions file $file."
		exit 2
	}
	kind=$(field "$file" "$name" kind)
	if [[ -z "$kind" ]]; then
		>&2 echo "No question $name in $file."
		exit 2
	fi
	text=$(field "$file" "$name" text)
	threshold=$(field "$file" "$name" threshold)
	while IFS= read -r option; do
		[[ -n "$option" ]] && options+=("$option")
	done < <(NAME=$name yq -r '.questions[] | select(.name == strenv(NAME)) | .options[]' "$file")
	case $kind in
	binary | choice | score)
		if ((${#candidates[@]} > 0)); then
			>&2 echo "Only a rank question takes candidates."
			exit 2
		fi
		# A binary question decides at its own threshold, 0.5 when unset. A
		# choice or a score is confident from UNCERTAIN_MIN on.
		if [[ -z "$threshold" ]]; then
			threshold=$UNCERTAIN_MIN
			[[ "$kind" == binary ]] && threshold=0.5
		fi
		args=("$kind" "$text" ${options[@]+"${options[@]}"} --threshold "$threshold" --json --quiet)
		;;
	rank)
		if ((${#candidates[@]} < 2)); then
			>&2 echo "A rank question needs at least two candidates."
			exit 2
		fi
		threshold=null
		args=(rank "$text" "${candidates[@]}" --json --quiet)
		;;
	*)
		>&2 echo "The question $name has the unknown kind $kind."
		exit 2
		;;
	esac
	if ((has_context)); then
		json=$(decisionkit "${args[@]}" --context "$context" </dev/null)
	else
		json=$(decisionkit "${args[@]}")
	fi
	rc=$?
	# Exit code 1 only means false or below the threshold. The JSON still
	# holds the answer.
	if ((rc > 1)) || ! jq -e '.answers.q' <<<"$json" >/dev/null 2>&1; then
		>&2 echo "decisionkit failed on $name. Run: decisionkit status"
		exit 2
	fi
	# Each comparison in an object value has parentheses, because jq 1.7
	# cannot parse it without them.
	jq -c --arg name "$name" --arg kind "$kind" --argjson t "$threshold" \
		--argjson u "$UNCERTAIN_MIN" --argjson tie "$RANK_TIE" \
		--argjson c "$(printf '%s\n' ${candidates[@]+"${candidates[@]}"} | jq -R . | jq -s .)" '
		def abs: if . < 0 then -. else . end;
		.answers.q as $q
		| {name: $name, kind: $kind, threshold: $t}
		+ if $kind == "binary" then
			{answer: (if $q.probability_true >= $t then "true" else "false" end),
			 p: $q.probability_true, expected: null,
			 uncertain: (([$q.probability_true, 1 - $q.probability_true] | max) < $u)}
		elif $kind == "choice" then
			{answer: $q.choice, p: $q.probabilities[$q.choice], expected: null,
			 uncertain: ($q.probabilities[$q.choice] < $u)}
		elif $kind == "score" then
			{answer: $q.most_likely, p: $q.probabilities[$q.most_likely],
			 expected: $q.expected_level, uncertain: ($q.probabilities[$q.most_likely] < $u)}
		else
			{answer: [$q.ranking[] | $c[.candidate_id | ltrimstr("c") | tonumber]],
			 p: null, expected: [$q.ranking[].expected_level],
			 uncertain: (($q.ranking | length) > 1
				and (($q.ranking[0].expected_level - $q.ranking[1].expected_level) | abs) < $tie)}
		end' <<<"$json"
	return "$rc"
}

# Score each fixture of each question in the questions file $1 against its
# label. $2 is the fixtures folder.
calibrate() {
	local file=$1 dir=$2 name kind fixture label line rc got p result count=0 status=0 low high
	local unsure=0 wrong=0
	if [[ ! -f "$file" ]]; then
		>&2 echo "$file: no such questions file."
		exit 2
	fi
	printf '%-14s %-8s %-8s %-6s %-9s %s\n' question want got p result fixture
	while IFS= read -r name; do
		kind=$(field "$file" "$name" kind)
		[[ "$kind" == rank ]] && continue
		low="" high=""
		for fixture in "$dir/$name"/*-*.txt; do
			[[ -f "$fixture" ]] || continue
			count=$((count + 1))
			label=$(basename "$fixture")
			label=${label%%-*}
			line=$(ask "$file" "$name" <"$fixture")
			rc=$?
			((rc > 1)) && exit 2
			got=$(jq -r '.answer' <<<"$line")
			p=$(jq -r '.p' <<<"$line")
			result=ok
			if [[ "$got" != "$label" ]]; then
				result=WRONG
				wrong=$((wrong + 1))
				status=1
			elif [[ "$(jq -r '.uncertain' <<<"$line")" == true ]]; then
				# The label matches, but no caller may present the answer as a decision.
				result=uncertain
				unsure=$((unsure + 1))
			fi
			printf '%-14s %-8s %-8s %-6s %-9s %s\n' "$name" "$label" "$got" "$p" "$result" "$(basename "$fixture")"
			if [[ "$kind" == binary && "$label" == true ]]; then
				[[ -z "$low" ]] || awk -v a="$p" -v b="$low" 'BEGIN { exit !(a < b) }' && low=$p
			elif [[ "$kind" == binary && "$label" == false ]]; then
				[[ -z "$high" ]] || awk -v a="$p" -v b="$high" 'BEGIN { exit !(a > b) }' && high=$p
			fi
		done
		if [[ -n "$low$high" ]]; then
			printf '%s: lowest true %s, highest false %s\n' "$name" "${low:-none}" "${high:-none}"
		fi
	done < <(yq -r '.questions[].name' "$file")
	if ((count == 0)); then
		>&2 echo "$dir holds no fixture."
		exit 2
	fi
	printf '%s fixtures: %s ok, %s uncertain, %s wrong\n' "$count" "$((count - unsure - wrong))" "$unsure" "$wrong"
	return "$status"
}

(($# >= 1)) || usage
load_limits
case $1 in
ask)
	(($# >= 3)) || usage
	shift
	ask "$@"
	;;
calibrate)
	(($# == 3)) || usage
	calibrate "$2" "$3"
	;;
*) usage ;;
esac
