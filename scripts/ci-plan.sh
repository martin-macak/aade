#!/usr/bin/env bash

# Plan the CI run of a change, and run the bats suites that it affects.
# The repository has two layers. The repo layer (scripts, skills, agent
# config, docs, the GitHub config, mise.toml) belongs to mise. The code
# layer belongs to pnpm. A change runs only the jobs and suites that it
# can break.
# Usage:
#   ci-plan.sh plan [--base <ref>] [--full] [--all] [<file>...]
#   ci-plan.sh test [--base <ref>] [--all] [<file>...]
# The changed files are the given files. Without files, they are the diff
# from the merge-base of <ref> (default origin/main) and HEAD, plus the
# staged, unstaged and untracked files.
# Layers: a path that starts with an entry of CODE_PATHS is code layer.
# Every other path is repo layer, so a new path never skips the checks.
# Shared inputs run every suite: a file in tests/scripts/helpers/, the CI
# workflow and a change to the [tools] table of mise.toml. The table is
# compared with the merge-base, or with HEAD when files are given.
# plan: prints the lines repo=, code=, full= and test= for GITHUB_OUTPUT.
# full is true for a shared input or --full (the ci:full label). test is
# true when a suite is affected. --all sets every value to true, for the
# weekly run.
# test: runs the affected suites of script-tests.sh and skill-drift.sh in
# one parallel run of script-tests.sh bats. --all runs every suite. It
# needs bats on PATH.
# Both modes need git, and yq when mise.toml changed. Run it from the
# repository root.
# Exit codes: 0 pass or nothing affected, 1 a suite failed or git found no
# merge-base, 2 wrong usage or a suite list failed.

# The code layer. Empty until the pnpm monorepo exists. Each entry is a
# path prefix, such as packages/.
CODE_PATHS=()

usage() {
	>&2 echo "Usage: ci-plan.sh plan [--base <ref>] [--full] [--all] [<file>...] | ci-plan.sh test [--base <ref>] [--all] [<file>...]"
	exit 2
}

if [[ ! -d scripts ]]; then
	>&2 echo "Run ci-plan.sh from the repository root."
	exit 2
fi

MODE=${1:-}
case $MODE in
plan | test) shift ;;
*) usage ;;
esac

BASE='' FULL=0 ALL=0 FILES=()
while (($# > 0)); do
	case $1 in
	--base)
		(($# >= 2)) || usage
		BASE=$2
		shift 2
		;;
	--full)
		[[ $MODE == plan ]] || usage
		FULL=1
		shift
		;;
	--all)
		ALL=1
		shift
		;;
	-*) usage ;;
	*)
		FILES+=("$1")
		shift
		;;
	esac
done

# The revision that the [tools] table is compared with. --all needs no
# diff, so it also works without the base branch.
if ((ALL)); then
	FROM=HEAD
elif [[ -n "$BASE" || ${#FILES[@]} -eq 0 ]]; then
	FROM=$(git merge-base "${BASE:-origin/main}" HEAD 2>/dev/null) || {
		>&2 echo "ci-plan: git found no merge-base of ${BASE:-origin/main} and HEAD."
		exit 1
	}
else
	FROM=HEAD
fi

if ((${#FILES[@]} == 0 && !ALL)); then
	while IFS= read -r file; do
		[[ -n "$file" ]] && FILES+=("$file")
	done < <({
		git diff --name-only --no-renames "$FROM"
		git ls-files --others --exclude-standard
	} | sort -u)
fi

# Succeed when the path $1 is in the code layer.
in_code() {
	local path
	for path in "${CODE_PATHS[@]}"; do
		[[ "$1" == "$path"* ]] && return 0
	done
	return 1
}

# Succeed when the [tools] table of mise.toml differs from the one in $FROM.
tools_changed() {
	local old new
	new=$(yq -p toml -o json '.tools' mise.toml 2>/dev/null)
	old=$(git show "$FROM:mise.toml" 2>/dev/null | yq -p toml -o json '.tools' 2>/dev/null)
	[[ "$old" != "$new" ]]
}

REPO=false CODE=false SHARED=0 REPO_FILES=()
for file in "${FILES[@]}"; do
	if in_code "$file"; then
		CODE=true
		continue
	fi
	REPO=true
	REPO_FILES+=("$file")
	case $file in
	tests/scripts/helpers/* | .github/workflows/ci.yml) SHARED=1 ;;
	mise.toml) tools_changed && SHARED=1 ;;
	esac
done

# Succeed when every suite must run.
every_suite() {
	((ALL || FULL || SHARED))
}

# Print the affected suites, one per line. Fail when a list fails, so a
# broken list never reads as "no suite affected".
suites() {
	if every_suite; then
		scripts/script-tests.sh run --list || return
		scripts/skill-drift.sh --list || return
	elif ((${#REPO_FILES[@]} > 0)); then
		scripts/script-tests.sh run --list "${REPO_FILES[@]}" || return
		scripts/skill-drift.sh --list "${REPO_FILES[@]}" || return
	fi
}

if [[ $MODE == plan ]]; then
	if ((ALL)); then
		printf '%s\n' repo=true code=true full=true test=true
		exit 0
	fi
	full=false test=false
	every_suite && full=true
	if [[ $REPO == true ]]; then
		list=$(suites) || {
			>&2 echo "ci-plan: cannot list the affected suites."
			exit 2
		}
		[[ -n "$list" ]] && test=true
	fi
	printf '%s\n' "repo=$REPO" "code=$CODE" "full=$full" "test=$test"
	exit 0
fi

if every_suite; then
	echo "ci-plan: every suite runs."
elif ((${#REPO_FILES[@]} == 0)); then
	echo "ci-plan: no repo-layer file changed, so no suite runs."
	exit 0
fi
# One parallel run for the script suites and the skill suites, so the
# slowest suites of both start at once.
list=$(suites) || {
	>&2 echo "ci-plan: cannot list the affected suites."
	exit 2
}
SUITES=()
while IFS= read -r suite; do
	[[ -n "$suite" ]] && SUITES+=("$suite")
done <<<"$list"
((${#SUITES[@]} > 0)) || exit 0
scripts/script-tests.sh bats "${SUITES[@]}" || exit 1
