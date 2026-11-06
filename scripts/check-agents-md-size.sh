#!/usr/bin/env bash

# Fail when an AGENTS.md file has more lines than allowed.
# Usage: check-agents-md-size.sh [<file>...]
# Without files, it checks every AGENTS.md that git tracks or sees. The
# root AGENTS.md has the MAX_LINES limit. An AGENTS.md in a subfolder has
# the MAX_NESTED_LINES limit. The knowledge-curator skill explains why.
# Run it from the repository root.

MAX_LINES=50
MAX_NESTED_LINES=30

FILES=("$@")
if ((${#FILES[@]} == 0)); then
	while IFS= read -r -d '' file; do FILES+=("$file"); done < <(
		git ls-files -z --cached --others --exclude-standard -- AGENTS.md '*/AGENTS.md' | sort -zu
	)
fi

STATUS=0
for file in "${FILES[@]}"; do
	[[ -f "$file" ]] || continue
	limit=$MAX_NESTED_LINES
	[[ "${file#./}" == AGENTS.md ]] && limit=$MAX_LINES
	lines=$(wc -l <"$file" | tr -d ' ')
	if ((lines > limit)); then
		>&2 echo "$file has $lines lines. The limit is $limit."
		>&2 echo "Move task-specific content into a skill. See the knowledge-curator skill."
		STATUS=1
	fi
done
exit $STATUS
