#!/usr/bin/env bash

# Run the bats suites of the repository scripts, and check that every
# script has a suite. tests/AGENTS.md explains the layout.
# Usage:
#   script-tests.sh run [--list] [<file>...]   run the suites in tests/scripts
#   script-tests.sh coverage                   check that each script has a suite
# run: without files it runs every tests/scripts/*.bats. With files, it runs
# only the suites that the files can affect: scripts/<x>.sh runs
# tests/scripts/<x>.bats, and a suite runs itself. mise.toml runs
# mise-tasks.bats, which tests its inline tasks. A file in
# tests/scripts/helpers/ runs every suite. scripts/ci-plan.sh decides when
# a tool version change runs every suite. --list prints the suites and runs
# nothing. Without --list, it needs bats on PATH.
# coverage: each scripts/<x>.sh needs tests/scripts/<x>.bats. Each
# .agents/skills/<skill>/scripts/<x>.sh needs a tests/<x>.bats in its skill.
# Each tests/scripts/<x>.bats needs scripts/<x>.sh, except mise-tasks.bats,
# which tests the inline tasks of mise.toml, and helpers.bats, which tests
# tests/scripts/helpers/. No test file may hold a check that cannot fail.
# silent_checks below lists the rules.
# Run it from the repository root. It does not ask git, because a commit
# hook can export GIT_DIR, and git then reports the wrong root.
# Exit codes: 0 pass or nothing affected, 1 a test or the check failed,
# 2 wrong usage.

SUITES=tests/scripts
MISE_SUITE=mise-tasks.bats
HELPERS_SUITE=helpers.bats

usage() {
	>&2 echo "Usage: script-tests.sh run [--list] [<file>...] | script-tests.sh coverage"
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
	local file suite suites=() all=0 list=0
	if [[ ${1:-} == --list ]]; then
		list=1
		shift
	fi
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
	if ((list)); then
		printf '%s\n' "${suites[@]}" | sort -u
		return 0
	fi
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
		[[ "$name" == "$MISE_SUITE" || "$name" == "$HELPERS_SUITE" ]] && continue
		[[ -f "scripts/${name%.bats}.sh" ]] || {
			>&2 echo "$suite tests no script. scripts/${name%.bats}.sh is missing."
			status=1
		}
	done
	silent_checks || status=1
	return $status
}

# Print each line of a test file that holds a check that cannot fail. The
# rules read one statement per line, after a trailing ";" or "# comment".
# A [[ that does not close on its line runs on to the line with "]]".
# - A whole [[ ]] or (( )) is ignored by bash 3.2 in the middle of a test.
# - A line of tests joined by && passes when an early test fails, because
#   only the last command of a && list can fail a test.
# - ! cmd never fails a test, so it needs || with false, return, exit,
#   fail or a { } block.
# - An arithmetic statement such as ((n++)) fails a test when its value is
#   0, so it must be an assignment such as n=$((n + 1)).
silent_checks() {
	local files=() file
	for file in "$SUITES"/*.bats "$SUITES"/helpers/* .agents/skills/*/tests/*.bats .agents/skills/*/tests/helpers/*; do
		[[ -f "$file" ]] && files+=("$file")
	done
	((${#files[@]} > 0)) || return 0
	awk '
		function report(at, why) {
			printf "%s:%d: %s\n", FILENAME, at, why
			found = 1
		}
		function test_chain(stmt,   parts, n, i) {
			if (stmt ~ /\|\|/ || index(stmt, " && ") == 0) return 0
			n = split(stmt, parts, / && /)
			for (i = 1; i <= n; i++)
				if (parts[i] !~ /^(\[\[? |\(\(|test )/) return 0
			return 1
		}
		function check(stmt, at,   tail, inner) {
			if (stmt ~ /^\(\(/ && stmt ~ /\)\)$/) {
				inner = substr(stmt, 3, length(stmt) - 4)
				if (inner ~ /\+\+|--/ || inner ~ /(^|[^=!<>])=([^=]|$)/)
					report(at, "this (( )) statement fails a test when its value is 0. Write an assignment, such as n=$((n + 1)).")
				else
					report(at, CANNOT)
			} else if (stmt ~ /^\[\[ / && stmt ~ / \]\]$/) {
				report(at, CANNOT)
			} else if (stmt ~ /^! /) {
				tail = stmt
				if (sub(/.*\|\|[ \t]*/, "", tail) == 0 || tail !~ /^(false|return|exit|fail|\{)([ \t;]|$)/)
					report(at, CANNOT)
			} else if (test_chain(stmt)) {
				report(at, CANNOT)
			}
		}
		BEGIN { CANNOT = "this check cannot fail a test. Add || false." }
		FNR == 1 { open = "" }
		{
			line = $0
			sub(/^[ \t]+/, "", line)
			sub(/[ \t]+#[^"'\''`]*$/, "", line)
			sub(/[ \t]*;$/, "", line)
			sub(/[ \t]+$/, "", line)
			if (open != "") {
				open = open " " line
				if (line ~ /\]\]/) { check(open, start); open = "" }
				next
			}
			if (line ~ /^\[\[ / && line !~ /\]\]/) { open = line; start = FNR; next }
			check(line, FNR)
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
