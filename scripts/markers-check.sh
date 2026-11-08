#!/usr/bin/env bash

# Fail when a tracked file holds a task marker. A task marker notes work
# that is not done. The marker words are TODO, FIXME, XXX and HACK. Work
# notes do not belong in tracked files. A leftover goes in the
# "## Leftovers" section of the pull request, and the merge files it as an
# issue. The pr-shepherd skill explains the format.
# Usage: markers-check.sh [<file>...]
# With files, it checks only these files. Pre-commit passes the staged
# files. Without files, it checks every file of git ls-files, as CI does.
# It skips a path that is no file, such as a deleted file, and it skips a
# binary file. A symlink to a file counts as that file. Without files, it
# skips each tracked symlink, because git also tracks its target, such as
# AGENTS.md for CLAUDE.md, and a hit would print twice.
# A marker is a marker word that starts a token and is followed by a colon
# or a bracket, or a marker word right after a comment opener. Prose that
# only names the words is no marker.
# Each hit prints as file:line: text.
# Run it from the repository root.
# Exit codes: 0 clean, 1 markers found, 2 error.

# A marker word that starts a token and is followed by a colon or a bracket.
# This also catches the Kotlin call.
CALL_ERE='(^|[^[:alnum:]_])(TODO|FIXME|XXX|HACK)[[:space:]]*[:(]'
# A marker word right after a comment opener. When the repository gains a
# language with another opener, add it here and add a case to
# tests/scripts/markers-check.bats.
COMMENT_ERE='(#|//|/\*|\*|<!--)[[:space:]]*(TODO|FIXME|XXX|HACK)([^[:alnum:]_]|$)'

FILES=("$@")
if ((${#FILES[@]} == 0)); then
	# Git prints its own error outside a repository.
	git rev-parse --git-dir >/dev/null || exit 2
	while IFS= read -r -d '' file; do
		[[ -L "$file" ]] || FILES+=("$file")
	done < <(git ls-files -z)
fi

STATUS=0
for file in "${FILES[@]}"; do
	[[ -f "$file" ]] || continue
	# The C locale makes grep read stray bytes as text. -I skips a file with
	# NUL bytes, which is binary.
	hits=$(LC_ALL=C grep -InE -e "$CALL_ERE" -e "$COMMENT_ERE" -- "$file")
	case $? in
	0)
		while IFS= read -r hit; do
			printf '%s:%s: %s\n' "$file" "${hit%%:*}" "${hit#*:}"
		done <<<"$hits"
		((STATUS == 2)) || STATUS=1
		;;
	1) ;;
	*) STATUS=2 ;;
	esac
done
((STATUS == 1)) &&
	>&2 echo 'Move each follow-up to the "## Leftovers" section of the pull request. The pr-shepherd skill explains the format.'
exit $STATUS
