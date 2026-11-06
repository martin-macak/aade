#!/usr/bin/env bats

# Tests for the commands of scripts/research.sh. Each test works on a copy
# of fixtures/good in a temporary research root, with a fixed date.
# fixtures.bats tests the rules of the check. No LLM and no network.

setup() {
	SKILL_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
	R="$SKILL_DIR/scripts/research.sh"
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/research"
	export RESEARCH_TODAY=2026-11-06
	mkdir -p "$RESEARCH_ROOT"
	cp -R "$SKILL_DIR/tests/fixtures/good/." "$RESEARCH_ROOT/"
	V="$RESEARCH_ROOT/hook-runner-choice"
	cd "$BATS_TEST_TMPDIR"
}

# Run a fresh research "q" with one requested comparison.
new_research() {
	"$R" init q --title "Queue choice" --author "Ann Lee" --artifact comparison >/dev/null
}

# Replace the text $2 with $3 in the file $1. Fail when $2 is missing.
swap() {
	grep -qF -- "$2" "$1" || {
		echo "swap: '$2' is not in $1"
		return 1
	}
	FROM=$2 TO=$3 perl -0pi -e 's/\Q$ENV{FROM}\E/$ENV{TO}/' "$1"
}

# ------------------------------------------------------------------ check

@test "check passes a root without research folders" {
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/empty"
	mkdir -p "$RESEARCH_ROOT"
	echo "# Research" >"$RESEARCH_ROOT/README.md"
	run "$R" check
	[ "$status" -eq 0 ]
}

# ------------------------------------------------------------ init and add

@test "init creates the required artifacts from the templates" {
	run "$R" init q --title "Queue choice" --author "Ann Lee" --author Bo --depth deep --artifact comparison
	[ "$status" -eq 0 ]
	for type in brief report sources; do
		f="$RESEARCH_ROOT/q/$type.md"
		[ -f "$f" ]
		[ "$(yq --front-matter=extract '.type' "$f")" = "$type" ]
		[ "$(yq --front-matter=extract '.created' "$f")" = 2026-11-06 ]
		[ "$(yq --front-matter=extract '.authors | join(",")' "$f")" = "Ann Lee,Bo" ]
		grep -qx '# Queue choice' "$f"
	done
	[ "$(yq --front-matter=extract '.depth' "$RESEARCH_ROOT/q/brief.md")" = deep ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = comparison ]
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "init gives the same files on every run" {
	new_research
	mv "$RESEARCH_ROOT/q" "$BATS_TEST_TMPDIR/first"
	new_research
	diff -r "$BATS_TEST_TMPDIR/first" "$RESEARCH_ROOT/q"
}

@test "init refuses a bad slug, an existing folder and an unknown artifact" {
	run "$R" init Bad_Slug --title T --author A
	[ "$status" -eq 2 ]
	new_research
	run "$R" init q --title T --author A
	[ "$status" -eq 1 ]
	run "$R" init r --title T --author A --artifact essay
	[ "$status" -eq 2 ]
	run "$R" init r --title T
	[ "$status" -eq 2 ]
}

@test "add creates a named artifact and records it in a draft brief" {
	new_research
	run "$R" add q tech-profile --name sqs --title "Amazon SQS" --author "Ann Lee"
	[ "$status" -eq 0 ]
	f="$RESEARCH_ROOT/q/tech-profile-sqs.md"
	[ "$(yq --front-matter=extract '.type' "$f")" = tech-profile ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = comparison,tech-profile ]
	run "$R" add q tech-profile --name sqs --title X --author A
	[ "$status" -eq 1 ]
}

@test "add refuses an existing required type and a type that a final brief does not request" {
	new_research
	run "$R" add q report --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"exists already."* ]]
	swap "$RESEARCH_ROOT/q/brief.md" "status: draft" "status: final"
	run "$R" add q experiment --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Ask the user to change the brief."* ]]
	[ ! -e "$RESEARCH_ROOT/q/experiment.md" ]
}

@test "add creates a missing required file again" {
	new_research
	rm "$RESEARCH_ROOT/q/sources.md"
	run "$R" add q sources --title "Queue choice" --author "Ann Lee"
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = comparison ]
	run "$R" check q
	[ "$status" -eq 0 ]
}

# ---------------------------------------------------------------- sources

@test "source add allocates IDs, sets the date and skips a known url" {
	new_research
	run "$R" source add q --kind primary --author AWS --title "SQS | Quotas" --url https://example.com/a --evidence "Fourteen days at most."
	[ "$status" -eq 0 ]
	[ "$output" = S1 ]
	run "$R" source add q --kind tertiary --author Bo --title B --url https://example.com/b --evidence E --published 2025-01-02
	[ "$output" = S2 ]
	run "$R" source add q --kind primary --author X --title X --url https://example.com/a --evidence X
	[ "$status" -eq 0 ]
	[ "${lines[${#lines[@]} - 1]}" = S1 ]
	grep -qxF '| title | SQS \| Quotas |' "$RESEARCH_ROOT/q/sources.md"
	grep -qxF '| accessed | 2026-11-06 |' "$RESEARCH_ROOT/q/sources.md"
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "source add takes the highest ID plus one" {
	run "$R" source add hook-runner-choice --kind primary --author A --title T --url https://example.com/new --evidence E
	[ "$output" = S5 ]
	perl -0pi -e 's/### S5\n/### S9\n/' "$V/sources.md"
	run "$R" source add hook-runner-choice --kind primary --author A --title T --url https://example.com/next --evidence E
	[ "$output" = S10 ]
}

@test "source add refuses bad values" {
	new_research
	run "$R" source add q --kind blog --author A --title T --url https://example.com --evidence E
	[ "$status" -eq 2 ]
	run "$R" source add q --kind primary --author A --title T --url ftp://example.com --evidence E
	[ "$status" -eq 2 ]
	run "$R" source add q --kind primary --author A --title T --url https://example.com --evidence E --published 2025
	[ "$status" -eq 2 ]
	run "$R" source add q --kind primary --author A --title T --url https://example.com --evidence $'two\nlines'
	[ "$status" -eq 2 ]
	! grep -q '^### S' "$RESEARCH_ROOT/q/sources.md"
}

# ------------------------------------------------------------------ cite

@test "cite sync writes the definitions once and then changes nothing" {
	new_research
	"$R" source add q --kind primary --author AWS --title Quotas --url https://example.com/a --evidence E >/dev/null
	swap "$RESEARCH_ROOT/q/report.md" "## Analysis" $'## Analysis\n\nSQS keeps a message for 14 days.[^S1]'
	RESEARCH_TODAY=2026-11-07 run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ "$output" = "$RESEARCH_ROOT/q/report.md" ]
	[ "$(tail -n 1 "$RESEARCH_ROOT/q/report.md")" = "[^S1]: [S1](sources.md#s1) AWS, Quotas." ]
	[ "$(yq --front-matter=extract '.updated' "$RESEARCH_ROOT/q/report.md")" = 2026-11-07 ]
	cp "$RESEARCH_ROOT/q/report.md" "$BATS_TEST_TMPDIR/once"
	RESEARCH_TODAY=2026-11-08 run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	cmp "$BATS_TEST_TMPDIR/once" "$RESEARCH_ROOT/q/report.md"
}

@test "cite sync leaves a file with an unknown ID unchanged" {
	swap "$V/report.md" "current set of hooks." "current set of hooks.[^S9]"
	cp "$V/report.md" "$BATS_TEST_TMPDIR/before"
	run "$R" cite sync hook-runner-choice
	[ "$status" -eq 1 ]
	[[ "$output" == *"cites sources that are not in sources.md: S9."* ]]
	cmp "$BATS_TEST_TMPDIR/before" "$V/report.md"
}

@test "cite sync ignores citations in code and comments" {
	new_research
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

# ---------------------------------------------------------------- status

@test "status moves the brief through review to final and sets the date" {
	new_research
	perl -pi -e 's/<!-- fill:.*-->/Filled./' "$RESEARCH_ROOT/q/brief.md"
	RESEARCH_TODAY=2026-11-09 run "$R" status q brief.md review
	[ "$status" -eq 0 ]
	RESEARCH_TODAY=2026-11-10 run "$R" status q brief.md final
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.status' "$RESEARCH_ROOT/q/brief.md")" = final ]
	[ "$(yq --front-matter=extract '.updated' "$RESEARCH_ROOT/q/brief.md")" = 2026-11-10 ]
}

@test "status refuses a skipped step and keeps the file on a failed check" {
	new_research
	run "$R" status q report.md final
	[ "$status" -eq 1 ]
	[[ "$output" == *"cannot move from draft to final"* ]]
	cp "$RESEARCH_ROOT/q/report.md" "$BATS_TEST_TMPDIR/before"
	run "$R" status q report.md review
	[ "$status" -eq 1 ]
	[[ "$output" == *"the brief is not final yet."* ]]
	[[ "$output" == *"The status stays draft."* ]]
	cmp "$BATS_TEST_TMPDIR/before" "$RESEARCH_ROOT/q/report.md"
}

@test "status supersedes a final artifact only with an existing successor" {
	new_research
	run "$R" status hook-runner-choice recommendation.md superseded
	[ "$status" -eq 2 ]
	run "$R" status hook-runner-choice recommendation.md superseded --by q
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.superseded_by' "$V/recommendation.md")" = q ]
	run "$R" check hook-runner-choice
	[ "$status" -eq 0 ]
}
