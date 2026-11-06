#!/usr/bin/env bats

# Tests for scripts/research.sh. Each test works on a copy of the fixtures
# in a temporary research root, with a fixed date. No LLM and no network.

setup() {
	SKILL_DIR=$(cd "$BATS_TEST_DIRNAME/.." && pwd)
	R="$SKILL_DIR/scripts/research.sh"
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/research"
	export RESEARCH_TODAY=2026-11-06
	mkdir -p "$RESEARCH_ROOT"
	cp -R "$SKILL_DIR/tests/fixtures/valid/." "$RESEARCH_ROOT/"
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

# Run check and expect exit 1 with the message $1 in the output.
expect_problem() {
	run "$R" check
	[ "$status" -eq 1 ] || {
		echo "check exited $status: $output"
		return 1
	}
	[[ "$output" == *"$1"* ]] || {
		echo "Expected '$1' in: $output"
		return 1
	}
}

# ------------------------------------------------------------------ check

@test "check passes the valid fixture" {
	run "$R" check
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "check passes a root without research folders" {
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/empty"
	mkdir -p "$RESEARCH_ROOT"
	echo "# Research" >"$RESEARCH_ROOT/README.md"
	run "$R" check
	[ "$status" -eq 0 ]
}

@test "check reports a missing template heading" {
	swap "$V/tech-profile-lefthook.md" "## Limits" "## Edges"
	expect_problem "missing the heading '## Limits' of the template."
}

@test "check reports a file name outside the closed set" {
	cp "$V/report.md" "$V/notes.md"
	expect_problem "notes.md: not an artifact name."
}

@test "check reports a suffix on a type that is not repeatable" {
	cp "$V/report.md" "$V/report-extra.md"
	expect_problem "report-extra.md: not an artifact name."
}

@test "check reports a front matter type that differs from the file name" {
	swap "$V/comparison.md" "type: comparison" "type: report"
	expect_problem "front matter type is 'report', but the file name gives 'comparison'."
}

@test "check reports an unknown status and a bad date" {
	swap "$V/report.md" "status: final" "status: done"
	swap "$V/report.md" 'created: "2026-11-01"' 'created: "1 Nov"'
	expect_problem "status 'done' must be one of: draft review final superseded."
	[[ "$output" == *"report.md: created must be YYYY-MM-DD."* ]]
}

@test "check reports a missing author list" {
	swap "$V/report.md" $'authors:\n  - aade maintainers' 'authors: []'
	expect_problem "report.md: front matter needs a list of authors."
}

@test "check reports a missing required file" {
	rm "$V/sources.md"
	expect_problem "hook-runner-choice: missing sources.md."
}

@test "check reports a slug that is not kebab-case" {
	mv "$V" "$RESEARCH_ROOT/Hook_Runner"
	expect_problem "the slug must be kebab-case"
}

@test "check reports a placeholder left in a final file" {
	swap "$V/recommendation.md" "## Follow-up" $'## Follow-up\n\n<!-- fill: more text. -->'
	expect_problem "recommendation.md: a '<!-- fill: -->' placeholder is left."
}

@test "check allows a placeholder in a draft file" {
	swap "$V/recommendation.md" "status: final" "status: draft"
	swap "$V/recommendation.md" "## Follow-up" $'## Follow-up\n\n<!-- fill: more text. -->'
	run "$R" check
	[ "$status" -eq 0 ]
}

@test "check reports a final diagram type without a Mermaid diagram" {
	perl -0pi -e 's/```mermaid.*?```\n//s' "$V/tech-profile-lefthook.md"
	expect_problem "a tech-profile needs at least one Mermaid diagram."
}

@test "check reports a Mermaid diagram without prose after it" {
	perl -0pi -e 's/(```\n\n)The diagram shows[^\n]*\n[^\n]*\n/$1/' "$V/report.md"
	expect_problem "report.md: the Mermaid diagram at line 18 needs a prose paragraph right after it."
}

@test "check reports a citation that the register does not hold" {
	swap "$V/report.md" "current set of hooks." "current set of hooks.[^S9]"
	expect_problem "report.md: cites sources that are not in sources.md: S9."
}

@test "check reports stale footnote definitions" {
	perl -ni -e 'print unless /^\[\^S4\]: /' "$V/report.md"
	expect_problem "report.md: the footnote definitions are out of date. Run: research.sh cite sync hook-runner-choice"
}

@test "check reports a key finding without a primary source" {
	swap "$V/report.md" "to a git revision.[^S1]" "to a git revision.[^S4]"
	expect_problem "report.md: key finding 1 cites no primary source and is not marked (unverified)."
}

@test "check reports bad register entries" {
	swap "$V/sources.md" "| kind | secondary |" "| kind | blog |"
	swap "$V/sources.md" "| url | https://github.com/pre-commit/pre-commit |" "| url | https://pre-commit.com/ |"
	swap "$V/sources.md" "| evidence | pre-commit is a Python program. |" ""
	expect_problem "S4: kind 'blog' must be one of: primary secondary tertiary."
	[[ "$output" == *"S3: the url is already in the register."* ]]
	[[ "$output" == *"S3: missing 'evidence'."* ]]
}

@test "check reports a requested type without a file" {
	rm "$V/experiment-install-time.md"
	expect_problem "the brief requests the type experiment, but the folder has no file of it."
}

@test "check reports an artifact that the brief does not request" {
	swap "$V/brief.md" $'  - experiment\n' ''
	expect_problem "experiment-install-time.md: the brief does not request the type 'experiment' in artifacts."
}

@test "check reports a final artifact while the brief is not final" {
	swap "$V/brief.md" "status: final" "status: review"
	expect_problem "report.md: the status is final, but the brief is not final yet."
}

@test "check reports a superseded artifact without a successor" {
	swap "$V/recommendation.md" "status: final" "status: superseded"
	expect_problem "a superseded artifact needs superseded_by"
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

@test "add refuses a required type and a type that a final brief does not request" {
	new_research
	run "$R" add q report --title X --author A
	[ "$status" -eq 2 ]
	swap "$RESEARCH_ROOT/q/brief.md" "status: draft" "status: final"
	run "$R" add q experiment --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Ask the user to change the brief."* ]]
	[ ! -e "$RESEARCH_ROOT/q/experiment.md" ]
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
