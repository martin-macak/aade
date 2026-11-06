#!/usr/bin/env bash

# Lint the structure of the knowledge layer. The knowledge-curator skill
# explains each rule. Run it from the repository root. Prints every problem
# and exits non-zero when it finds one. scripts/agents-link.sh checks the
# symlinks, so this script does not.

MAX_SKILL_LINES=500
MIN_CASES=3
LEDGER=.agents/skills/knowledge-curator/references/agents-md-ledger.md
STATUS=0

fail() {
	>&2 echo "$1"
	STATUS=1
}

# Print the front matter of the file $1.
front_matter() {
	awk 'NR == 1 && /^---$/ { inside = 1; next } inside && /^---$/ { exit } inside' "$1"
}

# Each skill: a SKILL.md with a matching name, a description and the size
# limit, and the tests that the "Test a skill" section requires. Fewer
# cases cannot show that the description tells the skills apart.
for dir in .agents/skills/*/; do
	dir=${dir%/}
	name=$(basename "$dir")
	skill="$dir/SKILL.md"
	if [[ ! -f "$skill" ]]; then
		fail "$dir: missing SKILL.md."
		continue
	fi
	front=$(front_matter "$skill")
	grep -qE "^name: *$name *$" <<<"$front" || fail "$skill: front matter 'name' must be '$name'."
	grep -qE '^description:' <<<"$front" || fail "$skill: front matter has no 'description'."
	lines=$(wc -l <"$skill" | tr -d ' ')
	((lines > MAX_SKILL_LINES)) && fail "$skill: $lines lines. The limit is $MAX_SKILL_LINES. Move material to references/."
	grep -qsx 'include ../knowledge-curator/scripts/skill.mk' "$dir/Makefile" ||
		fail "$dir/Makefile: missing, or it does not include ../knowledge-curator/scripts/skill.mk."
	compgen -G "$dir/tests/*.bats" >/dev/null || fail "$dir/tests: needs a .bats file with drift tests."
	plus=$(grep -cs '^+ ' "$dir/tests/triggers.txt")
	minus=$(grep -cs '^- ' "$dir/tests/triggers.txt")
	if ((${plus:-0} < MIN_CASES || ${minus:-0} < MIN_CASES)); then
		fail "$dir/tests/triggers.txt: needs at least $MIN_CASES '+' and $MIN_CASES '-' tasks."
	fi
	questions=$(grep -cs '^Q: ' "$dir/tests/knowledge.txt")
	answers=$(grep -cs '^A: ' "$dir/tests/knowledge.txt")
	if ((${questions:-0} < MIN_CASES || ${questions:-0} != ${answers:-0})); then
		fail "$dir/tests/knowledge.txt: needs at least $MIN_CASES 'Q: ' lines, each with an 'A: ' line."
	fi
done

# Relative Markdown links resolve in every Markdown file that git tracks or
# sees. Symlinks to AGENTS.md are skipped, because their target is checked.
while IFS= read -r -d '' file; do
	[[ -f "$file" && ! -L "$file" ]] || continue
	while IFS= read -r target; do
		target="${target%%#*}"
		[[ -z "$target" || "$target" =~ ^[a-z]+: ]] && continue
		[[ -e "$(dirname "$file")/$target" ]] || fail "$file: broken link to '$target'."
	done < <(grep -oE '\]\([^) ]+\)' "$file" | sed -E 's/^\]\(//; s/\)$//')
done < <(git ls-files -z --cached --others --exclude-standard -- '*.md')

# A commit that adds or changes a line of the root AGENTS.md must also stage
# the ledger. Outside a commit nothing is staged, so this check passes.
if git diff --cached -U0 -- AGENTS.md | grep -qE '^\+[^+]' &&
	git diff --cached --quiet -- "$LEDGER"; then
	fail "AGENTS.md changed, but $LEDGER is not staged. Triage the change and record it."
fi

exit $STATUS
