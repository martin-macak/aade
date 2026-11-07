# Fake external tools for bats suites. The suites of tests/scripts get it
# through common.bash. A skill suite loads it directly:
#   load "$ROOT/tests/scripts/helpers/fakes"
# and lists tests/scripts/helpers/ in its .watch file.
#
# Each fake goes first on PATH and logs "<name> <args>" to $FAKE_LOG, one
# line per call. `calls` prints the log. $FAKE_DIR/<name>.argv logs the same
# calls with one <...> per argument, to show how the arguments split. The
# files of a fake live in $BATS_TEST_TMPDIR/fake/, so each test starts clean.

# Set the paths of the fakes for the current test.
fake_paths() {
	FAKE_BIN="$BATS_TEST_TMPDIR/bin"
	export FAKE_DIR="$BATS_TEST_TMPDIR/fake" FAKE_LOG="$BATS_TEST_TMPDIR/fake.log"
	mkdir -p "$FAKE_BIN" "$FAKE_DIR"
}

# Put a fake command $1 first on PATH. The bash code $2, if given, runs
# after the log lines, with the arguments in "$@". When $2 is -, the code
# comes from stdin. Without code the fake prints nothing and exits 0.
# Examples:
#   fake gh 'echo "[]"'
#   fake claude - <<'EOF'
#   cat >"$FAKE_DIR/prompt"
#   EOF
fake() {
	fake_paths
	{
		printf '#!/usr/bin/env bash\n'
		printf 'printf "%%s\\n" "%s $*" >>"$FAKE_LOG"\n' "$1"
		printf '{ [ "$#" -eq 0 ] || printf "<%%s>" "$@"; echo; } >>"$FAKE_DIR/%s.argv"\n' "$1"
		if [[ "${2:-}" == - ]]; then
			cat
		else
			printf '%s\n' "${2:-}"
		fi
	} >"$FAKE_BIN/$1"
	chmod +x "$FAKE_BIN/$1"
	[[ ":$PATH:" == *":$FAKE_BIN:"* ]] || PATH="$FAKE_BIN:$PATH"
}

# Print the calls that the fakes logged.
calls() {
	cat "$BATS_TEST_TMPDIR/fake.log" 2>/dev/null || true
}

# A fake gh. A call answers with the reply that gh_reply set for its first
# two arguments, such as "issue view", and exits 0. A call without a reply
# prints nothing. When an argument is "-", as in --body-file -, the fake
# saves stdin to $FAKE_DIR/gh.stdin.
fake_gh() {
	# shellcheck disable=SC2016 # The fake expands these at run time.
	fake gh '
for arg in "$@"; do
	[[ "$arg" == - ]] && cat >"$FAKE_DIR/gh.stdin"
done
reply="$FAKE_DIR/gh/$1 ${2:-}"
[[ -f "$reply.out" ]] && cat "$reply.out"
[[ -f "$reply.err" ]] && cat "$reply.err" >&2
exit "$(cat "$reply.status" 2>/dev/null || echo 0)"'
}

# Set the reply of the fake gh to the calls "$1", the first two arguments
# such as "label list". stdin is the output. $2 is the exit code, 0 by
# default. A non-zero code prints "gh: failed" to stderr. Example:
#   gh_reply "issue view" <<<'{"body": ""}'
#   gh_reply "issue edit" 4 </dev/null
gh_reply() {
	fake_paths
	mkdir -p "$FAKE_DIR/gh"
	cat >"$FAKE_DIR/gh/$1.out"
	echo "${2:-0}" >"$FAKE_DIR/gh/$1.status"
	if [[ "${2:-0}" != 0 ]]; then
		echo "gh: failed" >"$FAKE_DIR/gh/$1.err"
	else
		rm -f "$FAKE_DIR/gh/$1.err"
	fi
}

# A fake decisionkit. It reads the text from --context, or else from
# stdin, and appends it to $FAKE_DIR/decisionkit.text with a "---" line.
# Its answer depends on the kind, the first argument. The first option is
# the third argument.
#   binary  {"answers":{"q":{"probability_true":<DK_P>}}}, and exit 0 when
#           DK_P reaches --threshold (0.5 by default), else exit 1, as the
#           real tool does.
#   score   expected_level <DK_LEVEL>, and most_likely <DK_CHOICE> with
#           probability 0.9, exit 0.
#   choice  choice <DK_CHOICE> with probability 0.9, exit 0.
#   status  prints nothing, exit 0, and reads no stdin.
# DK_P is 0.9, DK_LEVEL 0.2, and DK_CHOICE the first option by default.
# DK_FAIL=1 makes each call print an error and exit 2. For other answers,
# write a responder with dk_responder. The fake sources it with the kind
# in $kind and the text in $text, and the responder must exit.
fake_decisionkit() {
	# shellcheck disable=SC2016 # The fake expands these at run time.
	fake decisionkit '
kind=${1:-} text="" threshold=0.5 prev="" context=0
for arg in "$@"; do
	case $prev in
	--context) text=$arg context=1 ;;
	--threshold) threshold=$arg ;;
	esac
	prev=$arg
done
if [[ $kind != status ]]; then
	((context)) || text=$(cat)
	printf "%s\n---\n" "$text" >>"$FAKE_DIR/decisionkit.text"
fi
if [[ -n "${DK_FAIL:-}" ]]; then
	echo "decisionkit: provider error" >&2
	exit 2
fi
[[ -f "$FAKE_DIR/decisionkit.responder" ]] && source "$FAKE_DIR/decisionkit.responder"
case $kind in
binary)
	p=${DK_P:-0.9}
	printf "{\"answers\":{\"q\":{\"type\":\"binary\",\"probability_true\":%s}}}\n" "$p"
	awk -v p="$p" -v t="$threshold" "BEGIN { exit !(p >= t) }"
	;;
score)
	pick=${DK_CHOICE:-$3}
	printf "{\"answers\":{\"q\":{\"type\":\"score\",\"expected_level\":%s,\"most_likely\":\"%s\",\"probabilities\":{\"%s\":0.9}}}}\n" "${DK_LEVEL:-0.2}" "$pick" "$pick"
	;;
choice)
	pick=${DK_CHOICE:-$3}
	printf "{\"answers\":{\"q\":{\"type\":\"choice\",\"choice\":\"%s\",\"probabilities\":{\"%s\":0.9}}}}\n" "$pick" "$pick"
	;;
esac'
}

# Write the responder of the fake decisionkit from stdin. Example:
#   dk_responder <<<'[[ "$text" == *WRONG* ]] && DK_P=0.1'
# A responder that sets a DK_ variable and does not exit keeps the default
# answer with that value.
dk_responder() {
	fake_paths
	cat >"$FAKE_DIR/decisionkit.responder"
}

# A fake mise in the folder $1, or first on PATH without $1.
#   mise run <task>   saves the folder and the settings
#                     MISE_TRUSTED_CONFIG_PATHS and MISE_YES that it saw as
#                     "cwd=.. trusted=.. yes=.." in $FAKE_DIR/mise.run,
#                     prints $MISE_RUN_OUTPUT, prints $MISE_RUN_ERROR on
#                     stderr and exits $MISE_RUN_STATUS (0 by default).
#   mise exec -- <command> runs the command with the PATH that the test had
#                     when it called fake_mise, without the fake folders,
#                     so the real jq or yq answers. A command that the test
#                     faked, such as vale, answers as its fake does.
#                     MISE_EXEC_STATUS, when set, makes each exec print an
#                     error and exit with that code instead.
# Every other call only logs.
fake_mise() {
	fake_paths
	local real=":$PATH:"
	real=${real//":$FAKE_BIN:"/:}
	[[ -z "${1:-}" ]] || real=${real//":$1:"/:}
	real=${real#:}
	real=${real%:}
	local body
	# shellcheck disable=SC2016 # The fake expands these at run time.
	body='
if [[ "${1:-}" == run ]]; then
	printf "cwd=%s trusted=%s yes=%s\n" "$PWD" "${MISE_TRUSTED_CONFIG_PATHS-unset}" "${MISE_YES-unset}" >>"$FAKE_DIR/mise.run"
	[[ -n "${MISE_RUN_OUTPUT:-}" ]] && printf "%s\n" "$MISE_RUN_OUTPUT"
	[[ -n "${MISE_RUN_ERROR:-}" ]] && printf "%s\n" "$MISE_RUN_ERROR" >&2
	exit "${MISE_RUN_STATUS:-0}"
fi
if [[ "${1:-} ${2:-}" == "exec --" ]]; then
	shift 2
	if [[ -n "${MISE_EXEC_STATUS:-}" ]]; then
		echo "mise: exec failed" >&2
		exit "$MISE_EXEC_STATUS"
	fi
	[[ -x "'"$FAKE_BIN"'/$1" ]] && exec "'"$FAKE_BIN"'/$1" "${@:2}"
	PATH='"$(printf %q "$real")"'
	exec "$@"
fi'
	fake mise "$body"
	if [[ -n "${1:-}" ]]; then
		mkdir -p "$1"
		mv "$FAKE_BIN/mise" "$1/mise"
	fi
}
