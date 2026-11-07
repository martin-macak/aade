#!/usr/bin/env bash

# Run the bats suites of the repository scripts, and check that every
# script has a suite. tests/AGENTS.md explains the layout.
# Usage:
#   script-tests.sh run [<file>...]   run the suites in tests/scripts
#   script-tests.sh coverage          check that each script has a suite
# run: without files it runs every tests/scripts/*.bats. With files, as
# pre-commit passes them, it runs only the suites that the files can affect:
# scripts/<x>.sh runs tests/scripts/<x>.bats, a suite runs itself,
# mise.toml runs tests/scripts/mise-tasks.bats, and a file in
# tests/scripts/helpers/ runs every suite. It needs bats on PATH.
# coverage: each scripts/<x>.sh needs tests/scripts/<x>.bats. Each
# .agents/skills/<skill>/scripts/<x>.sh needs a tests/<x>.bats in its skill.
# Each tests/scripts/<x>.bats needs scripts/<x>.sh, except mise-tasks.bats,
# which tests the inline tasks of mise.toml. No test file may hold a check
# that cannot fail: a whole line of [[ ]] or (( )) is ignored by bash 3.2
# unless it is the last command of a test, and a line that starts with !
# never fails a test on any bash. Such a line needs `|| false`.
# Run it from the repository root. It does not ask git, because a commit
# hook can export GIT_DIR, and git then reports the wrong root.
# Exit codes: 0 pass or nothing affected, 1 a test or the check failed,
# 2 wrong usage.

SUITES=tests/scripts
MISE_SUITE=mise-tasks.bats

usage() {
	>&2 echo "Usage: script-tests.sh run [<file>...] | script-tests.sh coverage"
	exit 2
}

if [[ ! -d scripts ]]; then
	>&2 echo "Run script-tests.sh from the repository root."
	exit 2
fi

# Print the suite that the file $1 affects. Print "all" for a helper.
suite_of() {
	case $1 in
	"$SUITES"/helpers/*) echo all ;;
	"$SUITES"/*.bats) echo "$1" ;;
	scripts/*.sh) echo "$SUITES/$(basename "${1%.sh}").bats" ;;
	mise.toml) echo "$SUITES/$MISE_SUITE" ;;
	esac
}

run_suites() {
	local file suite suites=() all=0
	if (($# == 0)); then
		all=1
	fi
	for file in "$@"; do
		suite=$(suite_of "$file")
		if [[ "$suite" == all ]]; then
			all=1
		elif [[ -n "$suite" && -f "$suite" ]]; then
			suites+=("$suite")
		fi
	done
	if ((all)); then
		suites=()
		for suite in "$SUITES"/*.bats; do
			[[ -f "$suite" ]] && suites+=("$suite")
		done
	fi
	((${#suites[@]} > 0)) || return 0
	# One suite can appear twice, when both the script and its suite change.
	bats $(printf '%s\n' "${suites[@]}" | sort -u)
}

coverage() {
	local status=0 script suite name
	for script in scripts/*.sh; do
		[[ -f "$script" ]] || continue
		suite="$SUITES/$(basename "${script%.sh}").bats"
		[[ -f "$suite" ]] || {
			>&2 echo "$script has no suite. Add $suite."
			status=1
		}
	done
	for script in .agents/skills/*/scripts/*.sh; do
		[[ -f "$script" ]] || continue
		suite="$(dirname "$(dirname "$script")")/tests/$(basename "${script%.sh}").bats"
		[[ -f "$suite" ]] || {
			>&2 echo "$script has no suite. Add $suite."
			status=1
		}
	done
	for suite in "$SUITES"/*.bats; do
		[[ -f "$suite" ]] || continue
		name=$(basename "$suite")
		[[ "$name" == "$MISE_SUITE" ]] && continue
		[[ -f "scripts/${name%.bats}.sh" ]] || {
			>&2 echo "$suite tests no script. scripts/${name%.bats}.sh is missing."
			status=1
		}
	done
	silent_checks || status=1
	return $status
}

# Print each line of a test file that holds a check that cannot fail.
silent_checks() {
	local files=() file
	for file in "$SUITES"/*.bats "$SUITES"/helpers/* .agents/skills/*/tests/*.bats .agents/skills/*/tests/helpers/*; do
		[[ -f "$file" ]] && files+=("$file")
	done
	((${#files[@]} > 0)) || return 0
	awk '
		{ line = $0; sub(/^[ \t]+/, "", line); sub(/[ \t]+$/, "", line) }
		(line ~ /^\[\[ / && line ~ / \]\]$/) || (line ~ /^\(\(/ && line ~ /\)\)$/) || (line ~ /^! / && line !~ /\|\|/) {
			printf "%s:%d: this check cannot fail a test. Add || false.\n", FILENAME, FNR
			found = 1
		}
		END { exit found }' "${files[@]}" >&2
}

case ${1:-} in
run)
	shift
	run_suites "$@"
	;;
coverage)
	(($# == 1)) || usage
	coverage
	;;
*) usage ;;
esac
