#!/usr/bin/env bats

# scripts/lint-knowledge.sh keeps the knowledge layer well formed, so agents
# can trust it. It checks the structure of every skill, the relative links of
# every Markdown file, and that a change of the root AGENTS.md is recorded in
# the ledger. Pre-commit runs it. It prints each problem and exits 1.

load helpers/common

# Print $2 lines "<prefix> case N".
cases() {
	local i
	for ((i = 1; i <= $2; i++)); do
		printf '%s case %d\n' "$1" "$i"
	done
}

# Write the file $1 with the line $2.
md() {
	printf '%s\n' "$2" | fixture "$1"
}

# Write SKILL.md of the skill $1 with $2 lines in total.
skill_md() {
	{
		printf -- '---\nname: %s\ndescription: A test skill.\n---\n' "$1"
		seq 5 "$2" | sed 's/.*/Filler./'
	} | fixture ".agents/skills/$1/SKILL.md"
}

# Create a skill $1 that follows every rule.
make_skill() {
	local dir=.agents/skills/$1
	skill_md "$1" 5
	md "$dir/Makefile" 'include ../knowledge-curator/scripts/skill.mk'
	md "$dir/tests/drift.bats" '#!/usr/bin/env bats'
	{ cases + "$MIN"; cases - "$MIN"; } | fixture "$dir/tests/triggers.txt"
	{ cases Q: "$MIN"; cases A: "$MIN"; } | fixture "$dir/tests/knowledge.txt"
}

setup() {
	sandbox lint-knowledge.sh
	S=scripts/lint-knowledge.sh
	MAX=$(sed -n 's/^MAX_SKILL_LINES=//p' "$S")
	MIN=$(sed -n 's/^MIN_CASES=//p' "$S")
	LEDGER=$(sed -n 's/^LEDGER=//p' "$S")
	# The ledger sits in this skill, so the sandbox needs it as a valid skill.
	CURATOR=$(basename "$(dirname "$(dirname "$LEDGER")")")
	make_skill "$CURATOR"
	make_skill demo
	D=.agents/skills/demo
	git add -A
	git commit -q -m base
}

@test "the limits are positive numbers, and the ledger sits in a skill folder" {
	[ "$MAX" -gt 0 ]
	[ "$MIN" -gt 0 ]
	[ "$LEDGER" = ".agents/skills/$CURATOR/references/agents-md-ledger.md" ]
}

@test "passes a repository that follows every rule, and prints nothing" {
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

# --- Skill structure ---

@test "skill: fails a skill folder without SKILL.md" {
	rm "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D: missing SKILL.md."
}

@test "skill: no skill folder is no problem, and names no glob" {
	rm -rf .agents/skills/*
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	rm -rf .agents
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "skill: reports the problems of every skill, not only the first" {
	rm "$D/SKILL.md"
	skill_md "$CURATOR" 5
	sed -i.bak 's/^name: .*/name: wrong/' ".agents/skills/$CURATOR/SKILL.md"
	rm ".agents/skills/$CURATOR/SKILL.md.bak"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D: missing SKILL.md."
	has "$output" ".agents/skills/$CURATOR/SKILL.md: front matter 'name' must be '$CURATOR'."
}

@test "skill: fails a name that differs from the folder name" {
	sed -i.bak 's/^name: .*/name: other/' "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/SKILL.md: front matter 'name' must be 'demo'."
}

@test "skill: fails front matter without a name" {
	printf -- '---\ndescription: A test skill.\n---\n' | fixture "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "front matter 'name' must be 'demo'."
	lacks "$output" "no 'description'"
}

@test "skill: accepts spaces around the name in the front matter" {
	printf -- '---\nname:   demo  \ndescription: A test skill.\n---\n' | fixture "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 0 ]
}

@test "skill: fails front matter without a description" {
	printf -- '---\nname: demo\n---\n' | fixture "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/SKILL.md: front matter has no 'description'."
	lacks "$output" "must be 'demo'"
}

@test "skill: reads name and description only from the front matter" {
	printf 'name: demo\ndescription: In the body only.\n' | fixture "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "front matter 'name' must be 'demo'."
	has "$output" "front matter has no 'description'."
}

@test "skill: ignores a name that stands after the front matter ends" {
	printf -- '---\ndescription: A test skill.\n---\nname: demo\n' | fixture "$D/SKILL.md"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "front matter 'name' must be 'demo'."
}

@test "skill: passes SKILL.md at the line limit" {
	skill_md demo "$MAX"
	run "$S"
	[ "$status" -eq 0 ]
}

@test "skill: fails SKILL.md one line over the limit and says what to do" {
	skill_md demo $((MAX + 1))
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/SKILL.md: $((MAX + 1)) lines. The limit is $MAX. Move material to references/."
}

@test "skill: fails a skill without a Makefile" {
	rm "$D/Makefile"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/Makefile: missing, or it does not include ../knowledge-curator/scripts/skill.mk."
}

@test "skill: fails a Makefile that does not include skill.mk" {
	md "$D/Makefile" 'test:'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/Makefile: missing, or it does not include"
}

@test "skill: fails a Makefile that includes another file" {
	md "$D/Makefile" 'include ../other/scripts/skill.mk'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/Makefile: missing, or it does not include"
}

@test "skill: fails a Makefile where the include line has more text" {
	md "$D/Makefile" 'include ../knowledge-curator/scripts/skill.mk.old'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/Makefile: missing, or it does not include"
}

@test "skill: fails a skill without a .bats file" {
	rm "$D/tests/drift.bats"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests: needs a .bats file with drift tests."
}

@test "skill: fails a skill without a tests folder" {
	rm -r "$D/tests"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests: needs a .bats file with drift tests."
	has "$output" "$D/tests/triggers.txt: needs at least $MIN '+' and $MIN '-' tasks."
	has "$output" "$D/tests/knowledge.txt: needs at least $MIN 'Q: ' lines"
}

# --- Trigger and knowledge cases ---

@test "triggers: passes more cases than the minimum" {
	{ cases + $((MIN + 2)); cases - $((MIN + 2)); } | fixture "$D/tests/triggers.txt"
	run "$S"
	[ "$status" -eq 0 ]
}

@test "triggers: fails too few '+' tasks" {
	{ cases + $((MIN - 1)); cases - "$MIN"; } | fixture "$D/tests/triggers.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/triggers.txt: needs at least $MIN '+' and $MIN '-' tasks."
}

@test "triggers: fails too few '-' tasks" {
	{ cases + "$MIN"; cases - $((MIN - 1)); } | fixture "$D/tests/triggers.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/triggers.txt: needs at least $MIN '+' and $MIN '-' tasks."
}

@test "triggers: fails a missing triggers.txt" {
	rm "$D/tests/triggers.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/triggers.txt: needs at least $MIN '+' and $MIN '-' tasks."
}

@test "triggers: counts only lines that start with the sign and a space" {
	{ cases + "$MIN"; cases - "$MIN"; } | sed '1s/^+ /+/' | fixture "$D/tests/triggers.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "triggers.txt: needs at least"
}

@test "knowledge: fails too few questions" {
	{ cases Q: $((MIN - 1)); cases A: $((MIN - 1)); } | fixture "$D/tests/knowledge.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/knowledge.txt: needs at least $MIN 'Q: ' lines, each with an 'A: ' line."
}

@test "knowledge: fails a question without an answer" {
	{ cases Q: $((MIN + 1)); cases A: "$MIN"; } | fixture "$D/tests/knowledge.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/knowledge.txt: needs at least $MIN 'Q: ' lines"
}

@test "knowledge: fails an answer without a question" {
	{ cases Q: "$MIN"; cases A: $((MIN + 1)); } | fixture "$D/tests/knowledge.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/knowledge.txt: needs at least $MIN 'Q: ' lines"
}

@test "knowledge: passes more pairs than the minimum" {
	{ cases Q: $((MIN + 2)); cases A: $((MIN + 2)); } | fixture "$D/tests/knowledge.txt"
	run "$S"
	[ "$status" -eq 0 ]
}

@test "knowledge: fails a missing knowledge.txt" {
	rm "$D/tests/knowledge.txt"
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "$D/tests/knowledge.txt: needs at least $MIN 'Q: ' lines"
}

# --- Markdown links ---

@test "links: passes a link to an existing file" {
	md docs/a.md 'See [b](b.md).'
	md docs/b.md 'B.'
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "links: reports a broken link with the file and the target" {
	md docs/a.md 'See [b](missing.md).'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "docs/a.md: broken link to 'missing.md'."
}

@test "links: reports every broken link of every file" {
	printf '[x](one.md) and [y](two.md)\n' | fixture a.md
	md b.md '[z](three.md)'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "a.md: broken link to 'one.md'."
	has "$output" "a.md: broken link to 'two.md'."
	has "$output" "b.md: broken link to 'three.md'."
}

@test "links: resolves a link from the folder of the file" {
	md README.md 'Root.'
	md docs/a.md '[up](../README.md)'
	run "$S"
	[ "$status" -eq 0 ]
	md docs/b.md '[root](README.md)'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "docs/b.md: broken link to 'README.md'."
}

@test "links: accepts a link to a folder" {
	mkdir -p docs/sub
	md a.md '[d](docs/sub/)'
	run "$S"
	[ "$status" -eq 0 ]
}

@test "links: checks the file but not the anchor of a link" {
	md a.md '[s](b.md#section)'
	md b.md 'B has no such section.'
	run "$S"
	[ "$status" -eq 0 ]
}

@test "links: reports a broken link without its anchor" {
	md a.md '[s](missing.md#section)'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "a.md: broken link to 'missing.md'."
}

@test "links: skips a link to an anchor in the same file" {
	md a.md '[top](#top)'
	run "$S"
	[ "$status" -eq 0 ]
}

@test "links: ignores links with a scheme, such as https and mailto" {
	printf '[a](https://example.com/x) [b](http://example.com) [c](mailto:me@example.com)\n' | fixture a.md
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "links: checks image links like other links" {
	md a.md '![logo](img/logo.png)'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "a.md: broken link to 'img/logo.png'."
}

@test "links: checks Markdown files in subfolders" {
	md deep/er/a.md '[x](nope.md)'
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "deep/er/a.md: broken link to 'nope.md'."
}

@test "links: checks a file that git does not track yet" {
	md new.md '[x](nope.md)'
	run git ls-files --error-unmatch new.md
	[ "$status" -ne 0 ]
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "new.md: broken link to 'nope.md'."
}

@test "links: checks a file that git tracks" {
	md tracked.md '[x](nope.md)'
	git add tracked.md
	git commit -q -m tracked
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "tracked.md: broken link to 'nope.md'."
}

@test "links: skips a file that git ignores" {
	md .gitignore 'ignored/'
	md ignored/a.md '[x](nope.md)'
	run "$S"
	[ "$status" -eq 0 ]
}

@test "links: skips a tracked file that was deleted from the working tree" {
	md gone.md '[x](nope.md)'
	git add gone.md
	git commit -q -m gone
	rm gone.md
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "links: skips files that are not Markdown" {
	md notes.txt '[x](nope.md)'
	run "$S"
	[ "$status" -eq 0 ]
}

@test "links: skips a symlink, because its target is checked" {
	md docs/real.md '[s](sibling.md)'
	md docs/sibling.md 'Sibling.'
	ln -s docs/real.md link.md
	# From the folder of the link, the link of the target would not resolve.
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "links: reports a broken link in the target of a symlink once" {
	md AGENTS.md '[x](nope.md)'
	ln -s AGENTS.md CLAUDE.md
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "AGENTS.md: broken link to 'nope.md'."
	lacks "$output" "CLAUDE.md: broken link"
}

# --- Ledger of the root AGENTS.md ---

# Commit the root AGENTS.md and the ledger, so a later change shows in the
# index diff.
seed_agents() {
	md AGENTS.md '- rule one'
	md "$LEDGER" '# Ledger'
	git add -A
	git commit -q -m seed
}

@test "ledger: fails a staged new line in AGENTS.md without a staged ledger" {
	seed_agents
	printf -- '- rule one\n- rule two\n' | fixture AGENTS.md
	git add AGENTS.md
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "AGENTS.md changed, but $LEDGER is not staged. Triage the change and record it."
}

@test "ledger: fails a staged edit of a line in AGENTS.md without a staged ledger" {
	seed_agents
	md AGENTS.md '- rule one, reworded'
	git add AGENTS.md
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "AGENTS.md changed, but $LEDGER is not staged."
}

@test "ledger: fails a new root AGENTS.md without a staged ledger" {
	md "$LEDGER" '# Ledger'
	git add -A
	git commit -q -m ledger
	md AGENTS.md '- first rule'
	git add AGENTS.md
	run "$S"
	[ "$status" -eq 1 ]
	has "$output" "AGENTS.md changed, but $LEDGER is not staged."
}

@test "ledger: passes when the ledger is staged with the AGENTS.md change" {
	seed_agents
	printf -- '- rule one\n- rule two\n' | fixture AGENTS.md
	printf '# Ledger\n- rule two: triaged\n' | fixture "$LEDGER"
	git add AGENTS.md "$LEDGER"
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "ledger: passes an AGENTS.md change that is not staged" {
	seed_agents
	printf -- '- rule one\n- rule two\n' | fixture AGENTS.md
	run "$S"
	[ "$status" -eq 0 ]
}

@test "ledger: passes a staged change that only removes lines from AGENTS.md" {
	printf -- '- rule one\n- rule two\n' | fixture AGENTS.md
	md "$LEDGER" '# Ledger'
	git add -A
	git commit -q -m seed
	md AGENTS.md '- rule one'
	git add AGENTS.md
	run "$S"
	[ "$status" -eq 0 ]
}

@test "ledger: passes a staged change of a nested AGENTS.md" {
	seed_agents
	md docs/AGENTS.md '- local rule'
	git add docs/AGENTS.md
	run "$S"
	[ "$status" -eq 0 ]
}
