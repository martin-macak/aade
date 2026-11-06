#!/usr/bin/env bash

# Run the skill drift tests.
# Usage: skill-drift.sh [<file>...]
# Without files, it runs every tests/*.bats of every skill. With files, as
# pre-commit passes them, it runs only the test files that the files can
# affect. A file affects tests/<test>.bats of a skill when it is in the
# skill folder .agents/skills/<name>/, or when it starts with a line of
# tests/<test>.watch. A line of the .watch file is a repository path that
# the test file reads. A path that ends with "/" covers a folder.
# The knowledge-curator skill explains the layers.
# Run it from the repository root. It does not ask git, because a commit
# hook can export GIT_DIR, and git then reports the wrong root. It needs
# bats on PATH. Exit codes: 0 pass or nothing affected, 1 a test failed,
# 2 an error.

if [[ ! -d .agents/skills ]]; then
	>&2 echo "Run skill-drift.sh from the repository root."
	exit 2
fi

# Print the watched paths of a test file: $1 is the skill, $2 the file.
watched() {
	local watch=${2%.bats}.watch
	printf '%s\n' ".agents/skills/$1/"
	[[ -f "$watch" ]] || return 0
	grep -vE '^(#|[[:space:]]*$)' "$watch"
}

# Succeed when no files were given, or when one of them starts with a
# watched path.
affected() {
	local path file
	((${#FILES[@]} == 0)) && return 0
	while IFS= read -r path; do
		for file in "${FILES[@]}"; do
			[[ "$file" == "$path"* ]] && return 0
		done
	done < <(watched "$1" "$2")
	return 1
}

FILES=("$@")
STATUS=0
for dir in .agents/skills/*/; do
	[[ -d "$dir" ]] || continue
	name=$(basename "$dir")
	tests=()
	for test in "${dir}"tests/*.bats; do
		[[ -f "$test" ]] && affected "$name" "$test" && tests+=("$test")
	done
	((${#tests[@]} > 0)) || continue
	echo "==> $name"
	bats "${tests[@]}" || STATUS=1
done
exit $STATUS
