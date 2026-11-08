#!/usr/bin/env bats

# research.sh does every action on a research folder that must give the same
# result each time: it creates the typed artifacts from templates, adds
# sources, writes the footnotes, moves the status and checks the folder.
# A script does these steps so that an agent cannot get them slightly wrong.
# fixtures.bats pins most rules of the check. This file covers the actions,
# the usage errors and the check rules that have no fixture.

# run ! needs bats 1.5 or later.
bats_require_minimum_version 1.5.0

# Each test works on a copy of fixtures/good in a temporary research root,
# with a fixed date. No LLM and no network.
ROOT=$(cd "$BATS_TEST_DIRNAME/../../../.." && pwd)
load "$ROOT/tests/scripts/helpers/fakes"

setup() {
	# The script runs from a copy of the skill, so it cannot change the
	# repository.
	SKILL_DIR="$(skill_copy tech-research)/tech-research"
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

# Fill the brief of the research "q", so that it can leave draft.
fill_brief() {
	perl -pi -e 's/<!-- fill:.*-->/Filled./' "$RESEARCH_ROOT/q/brief.md"
}

# Assert that "research.sh <args>" is a usage error: it exits 2 and prints
# the usage.
usage_error() {
	run "$R" "$@"
	[ "$status" -eq 2 ] || {
		echo "'$*': exit $status"
		return 1
	}
	[[ "$output" == *"research.sh init <slug>"* ]] || {
		echo "'$*': no usage text"
		return 1
	}
}

# Run the check of "$@" and cut the research root from the paths of its output.
problems() {
	run "$R" check "$@"
	output=$(sed "s|$RESEARCH_ROOT/||g" <<<"$output")
}

# ------------------------------------------------------ usage and settings

@test "a call without a command prints the usage of every command and exits 2" {
	run "$R"
	[ "$status" -eq 2 ]
	for cmd in "init <slug>" "add <slug> <type>" "source add <slug>" "cite sync <slug>" \
		"status <slug> <file> <status>" "check [<slug>...]" "progress <slug>" "reopen <slug>"; do
		[[ "$output" == *"research.sh $cmd"* ]] || {
			echo "the usage lacks: $cmd"
			return 1
		}
	done
	# The usage is plain text: no comment marks, and not the next paragraph.
	[[ "$output" != *"# "* ]] || false
	[[ "$output" != *"Run it from"* ]] || false
}

@test "an unknown command exits 2 with the usage" {
	usage_error bogus
}

@test "init: a missing slug, a missing value or an unknown option exit 2" {
	usage_error init
	usage_error init q --title T --author A --bogus
	usage_error init q --author A --title
	usage_error init q --title T --author A --depth
}

@test "add: a missing slug or type, a missing value or an unknown option exit 2" {
	usage_error add
	usage_error add q
	usage_error add q report --title T --author A --bogus
	usage_error add q comparison --title T --author A --name
}

@test "source: a command other than add, a missing slug or an unknown option exit 2" {
	usage_error source
	usage_error source add
	usage_error source remove q
	usage_error source add q --bogus x
	usage_error source add q --kind
}

@test "cite: a command other than sync, a missing slug or an extra argument exit 2" {
	usage_error cite
	usage_error cite sync
	usage_error cite list q
	usage_error cite sync q extra
}

@test "status: a missing argument, an unknown option or a missing value exit 2" {
	usage_error status
	usage_error status q report.md
	usage_error status q report.md review --bogus
	usage_error status q report.md review --by
}

@test "progress and reopen: a missing slug or an extra argument exit 2" {
	usage_error progress
	usage_error progress q extra
	usage_error reopen
	usage_error reopen q extra
}

@test "a bad RESEARCH_TODAY exits 2 before an action writes a file" {
	RESEARCH_TODAY=06.11.2026 run "$R" init q --title T --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"RESEARCH_TODAY must have the form YYYY-MM-DD."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "a bad RESEARCH_TODAY stops each action that writes, and changes no file" {
	new_research
	before=$(find "$RESEARCH_ROOT" -type f -exec cksum {} + | sort)
	for args in "add q report" "source add q" "cite sync q" "status q brief.md review" "reopen hook-runner-choice"; do
		RESEARCH_TODAY=bad run "$R" $args
		[ "$status" -eq 2 ] || {
			echo "$args: exit $status"
			return 1
		}
		[[ "$output" == *"RESEARCH_TODAY must have the form YYYY-MM-DD."* ]] || false
	done
	[ "$(find "$RESEARCH_ROOT" -type f -exec cksum {} + | sort)" = "$before" ]
}

@test "check, progress and the usage ignore RESEARCH_TODAY, because they write no date" {
	RESEARCH_TODAY=bad run "$R" check
	[ "$status" -eq 0 ]
	RESEARCH_TODAY=bad run "$R" progress hook-runner-choice
	[ "$status" -eq 0 ]
	RESEARCH_TODAY=bad run "$R"
	[ "$status" -eq 2 ]
	[[ "$output" == *"research.sh init <slug>"* ]] || false
	[[ "$output" != *"RESEARCH_TODAY"* ]] || false
}

@test "the date is the date of today when RESEARCH_TODAY is unset" {
	unset RESEARCH_TODAY
	before=$(date +%F)
	"$R" init q --title T --author A >/dev/null
	after=$(date +%F)
	created=$(yq --front-matter=extract '.created' "$RESEARCH_ROOT/q/brief.md")
	[ "$created" = "$before" ] || [ "$created" = "$after" ]
}

@test "the research folder is docs/research under the current folder when RESEARCH_ROOT is unset" {
	unset RESEARCH_ROOT
	run "$R" init q --title T --author A
	[ "$status" -eq 0 ]
	[ -f docs/research/q/brief.md ]
	run "$R" check
	[ "$status" -eq 0 ]
}

# ------------------------------------------------------------------ check

@test "check passes a root without research folders" {
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/empty"
	mkdir -p "$RESEARCH_ROOT"
	echo "# Research" >"$RESEARCH_ROOT/README.md"
	run "$R" check
	[ "$status" -eq 0 ]
}

@test "check takes slugs and paths, and judges only the folders it is given" {
	swap "$RESEARCH_ROOT/cache-layer/report.md" "type: report" "type: brief"
	run "$R" check hook-runner-choice
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	problems cache-layer
	[ "$status" -eq 1 ]
	[[ "$output" == *"cache-layer/report.md: front matter type is 'brief'"* ]] || false
	problems "$RESEARCH_ROOT/cache-layer/"
	[ "$status" -eq 1 ]
	run "$R" check hook-runner-choice cache-layer
	[ "$status" -eq 1 ]
}

@test "check exits 2 for a folder that does not exist" {
	run "$R" check nosuch
	[ "$status" -eq 2 ]
	[ "$output" = "No research folder nosuch." ]
}

@test "check prints one 'path: message' line per problem, for every folder, and exits 1" {
	swap "$RESEARCH_ROOT/cache-layer/report.md" "type: report" "type: brief"
	swap "$V/recommendation.md" "status: final" "status: done"
	problems
	[ "$status" -eq 1 ]
	[[ "$output" == *"cache-layer/report.md: front matter type is 'brief'"* ]] || false
	[[ "$output" == *"hook-runner-choice/recommendation.md: status 'done' is not allowed."* ]] || false
	[ -z "$(grep -v '^[^ ]*: ' <<<"$output")" ]
}

@test "check reports a missing brief or report and says how to add it" {
	new_research
	rm "$RESEARCH_ROOT/q/brief.md" "$RESEARCH_ROOT/q/report.md"
	problems q
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' \
		"q: the required file brief.md is missing. Run: research.sh add q brief --title <t> --author <a>" \
		"q: the required file report.md is missing. Run: research.sh add q report --title <t> --author <a>")" ]
}

@test "check ignores a file that is not Markdown" {
	new_research
	echo "scratch notes" >"$RESEARCH_ROOT/q/notes.txt"
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "check reports a front matter without a title" {
	new_research
	"$R" add q comparison --title X --author A >/dev/null
	grep -v '^title:' "$RESEARCH_ROOT/q/comparison.md" >"$BATS_TEST_TMPDIR/c.md"
	cp "$BATS_TEST_TMPDIR/c.md" "$RESEARCH_ROOT/q/comparison.md"
	problems q
	[ "$status" -eq 1 ]
	[ "$output" = "q/comparison.md: front matter has no title. Add 'title: <text>', and make '# <text>' the first heading." ]
}

@test "check reports a front matter that is a list and not keys and values" {
	new_research
	printf -- '---\n- a\n- b\n---\n\n# Q\n' >"$RESEARCH_ROOT/q/comparison.md"
	problems q
	[ "$status" -eq 1 ]
	[[ "$output" == "q/comparison.md: the front matter is not valid YAML: it is not a list of keys and values."* ]] || false
}

@test "check reports a source ID that the register holds twice" {
	perl -0pi -e 's/### S2\n/### S1\n/' "$V/sources.md"
	problems hook-runner-choice
	[ "$status" -eq 1 ]
	[[ "$output" == *"hook-runner-choice/sources.md: the register has a source ID twice. Give each '### S<n>' heading its own number."* ]] || false
}

@test "check reports a bad archive, accessed and published value of a source" {
	swap "$V/sources.md" "| archive | https://web.archive.org/web/2026/https://github.com/evilmartians/lefthook |" "| archive | web.archive.org/lefthook |"
	swap "$V/sources.md" "| accessed | 2026-11-01 |" "| accessed | yesterday |"
	swap "$V/sources.md" "| published | unknown |" "| published | 2025 |"
	problems hook-runner-choice
	[ "$status" -eq 1 ]
	[ "$output" = "$(printf '%s\n' \
		"hook-runner-choice/sources.md: S1: accessed 'yesterday' is not a date. Write it as YYYY-MM-DD." \
		"hook-runner-choice/sources.md: S1: published '2025' is not a date. Write it as YYYY-MM-DD, or as unknown." \
		"hook-runner-choice/sources.md: S2: archive 'web.archive.org/lefthook' is not a full web address. Write it with http:// or https://, or remove the row.")" ]
}

@test "check reports a finding that cites an unknown ID once, as an unknown citation" {
	swap "$V/report.md" "parallel commands.[^S2]" "parallel commands.[^S9]"
	problems hook-runner-choice
	[ "$status" -eq 1 ]
	[ "$output" = "hook-runner-choice/report.md: cites S9, which sources.md does not have. Add each source with: research.sh source add hook-runner-choice, or fix the ID." ]
}

@test "check applies the completeness rules to a report from status review on" {
	new_research
	swap "$RESEARCH_ROOT/q/report.md" "status: draft" "status: review"
	problems q
	[ "$status" -eq 1 ]
	[[ "$output" == *"q/report.md: a '<!-- fill: -->' placeholder is left at line"* ]] || false
	[[ "$output" == *"q/report.md: a report in status review needs at least one Mermaid diagram."* ]] || false
	[[ "$output" == *"q/report.md: the status is review, but brief.md is draft."* ]] || false
	[[ "$output" == *"q/report.md: '## Key findings' has no list item."* ]] || false
	[[ "$output" == *"q: brief.md lists 'comparison' in artifacts, but the folder has no comparison file."* ]] || false
}

# Add the text $1 to the end of the report of a fresh research "q", and print
# the lines of the check that are about a diagram.
diagram_problems() {
	rm -rf "$RESEARCH_ROOT/q"
	new_research
	printf '%s\n' "$1" >>"$RESEARCH_ROOT/q/report.md"
	run "$R" check q
	grep 'Mermaid diagram' <<<"$output" || true
}

@test "check wants a paragraph right after a diagram: not a heading, a table, a comment, a footnote or the end" {
	fence='```'
	for tail in $'\n## Next steps' $'| a | b |\n| - | - |' '<!-- a note -->' '[^S1]: an example' ''; do
		found=$(diagram_problems "$fence"$'mermaid\nflowchart LR\n  A --> B\n'"$fence"$'\n'"$tail")
		[[ "$found" == *"the Mermaid diagram at line"*"has no prose paragraph right after it."* ]] || {
			echo "no problem for the tail: '$tail'"
			return 1
		}
	done
}

@test "check accepts a diagram that a paragraph follows, also after blank lines, and fences that are no diagram" {
	fence='```'
	diagram=$fence$'mermaid\nflowchart LR\n  A --> B\n'$fence
	for text in "$diagram"$'\n\n\nThe diagram shows a link.' \
		"$fence"$'sh\necho hi\n'"$fence"$'\n\n## Next steps' \
		"$diagram"$'\n\nFirst.\n\n'"$diagram"$'\nSecond.'; do
		found=$(diagram_problems "$text")
		[ -z "$found" ] || {
			echo "unexpected problem: $found"
			return 1
		}
	done
}

@test "check lists no other research when a superseded file has no successor and none exists" {
	export RESEARCH_ROOT="$BATS_TEST_TMPDIR/solo"
	mkdir -p "$RESEARCH_ROOT"
	cp -R "$SKILL_DIR/tests/fixtures/good/hook-runner-first-look" "$RESEARCH_ROOT/"
	sed '/^superseded_by:/d' "$RESEARCH_ROOT/hook-runner-first-look/report.md" >"$BATS_TEST_TMPDIR/r.md"
	cp "$BATS_TEST_TMPDIR/r.md" "$RESEARCH_ROOT/hook-runner-first-look/report.md"
	problems
	[ "$status" -eq 1 ]
	[[ "$output" == *"with the slug of the research that replaces this file: none."* ]] || false
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
	[[ "$output" == *"exists already."* ]] || false
	swap "$RESEARCH_ROOT/q/brief.md" "status: draft" "status: final"
	run "$R" add q experiment --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Ask the user to change the brief."* ]] || false
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

@test "init prints the path of each file it creates" {
	run "$R" init q --title T --author A
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' "$RESEARCH_ROOT/q/brief.md" "$RESEARCH_ROOT/q/report.md" "$RESEARCH_ROOT/q/sources.md")" ]
}

@test "init defaults to the standard depth, a draft status and no requested artifact" {
	"$R" init q --title T --author A >/dev/null
	[ "$(yq --front-matter=extract '.depth' "$RESEARCH_ROOT/q/brief.md")" = standard ]
	[ "$(yq --front-matter=extract '.status' "$RESEARCH_ROOT/q/brief.md")" = draft ]
	[ "$(yq --front-matter=extract '.artifacts | length' "$RESEARCH_ROOT/q/brief.md")" = 0 ]
}

@test "init lists a requested artifact once, in the order given" {
	"$R" init q --title T --author A --artifact experiment --artifact comparison --artifact experiment >/dev/null
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = experiment,comparison ]
}

@test "init creates nothing when a value is refused" {
	run "$R" init q --title T --author A --depth shallow
	[ "$status" -eq 2 ]
	[[ "$output" == *"--depth must be one of: quick standard deep."* ]] || false
	run "$R" init q --title T --author A --artifact report
	[ "$status" -eq 2 ]
	[[ "$output" == *"--artifact must be one of: comparison recommendation tech-profile experiment."* ]] || false
	run "$R" init q --title T
	[ "$status" -eq 2 ]
	[[ "$output" == *"Give at least one --author."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "init refuses an empty title or author, and a title or author of two lines or with a tab" {
	run "$R" init q --title "" --author A
	[ "$status" -eq 2 ]
	[ "$output" = "--title must not be empty." ]
	run "$R" init q --title $'two\nlines' --author A
	[ "$status" -eq 2 ]
	[ "$output" = "--title must be one line without tabs." ]
	run "$R" init q --title T --author ""
	[ "$status" -eq 2 ]
	[ "$output" = "--author must not be empty." ]
	run "$R" init q --title T --author $'a\tb'
	[ "$status" -eq 2 ]
	[ "$output" = "--author must be one line without tabs." ]
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "init keeps quotes, colons, hashes and dollar signs of a title and an author as plain text" {
	title='Cache: "fast" & $HOME #1'
	run "$R" init q --title "$title" --author "O'Neil"
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.title' "$RESEARCH_ROOT/q/brief.md")" = "$title" ]
	[ "$(yq --front-matter=extract '.authors[0]' "$RESEARCH_ROOT/q/brief.md")" = "O'Neil" ]
	grep -qxF "# $title" "$RESEARCH_ROOT/q/report.md"
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "add prints the path of the new file" {
	new_research
	run "$R" add q comparison --title X --author A
	[ "$status" -eq 0 ]
	[ "$output" = "$RESEARCH_ROOT/q/comparison.md" ]
}

@test "add exits 1 for a research that does not exist" {
	run "$R" add nosuch report --title X --author A
	[ "$status" -eq 1 ]
	[ "$output" = "No research nosuch. Run research.sh init first." ]
}

@test "add refuses a bad slug, an unknown type, a name on a single type and a name that is not kebab-case" {
	new_research
	run "$R" add Bad_Slug report --title X --author A
	[ "$status" -eq 2 ]
	run "$R" add q essay --title X --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"The type must be one of: brief report sources comparison recommendation tech-profile experiment."* ]] || false
	run "$R" add q report --name extra --title X --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"A report is not repeatable, so it takes no --name."* ]] || false
	run "$R" add q comparison --name Not_Kebab --title X --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"--name must be kebab-case."* ]] || false
	run "$R" add q comparison --title X
	[ "$status" -eq 2 ]
	[ ! -e "$RESEARCH_ROOT/q/comparison.md" ]
}

@test "add needs the brief before it adds an optional type" {
	new_research
	rm "$RESEARCH_ROOT/q/brief.md"
	run "$R" add q experiment --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"/q/brief.md is missing. Run: research.sh add q brief --title <t> --author <a>"* ]] || false
	[ ! -e "$RESEARCH_ROOT/q/experiment.md" ]
}

@test "add creates a missing brief or report again from its template" {
	new_research
	rm "$RESEARCH_ROOT/q/brief.md" "$RESEARCH_ROOT/q/report.md"
	run "$R" add q brief --title "Queue choice" --author "Ann Lee"
	[ "$status" -eq 0 ]
	run "$R" add q report --title "Queue choice" --author "Ann Lee"
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.type' "$RESEARCH_ROOT/q/brief.md")" = brief ]
	[ "$(yq --front-matter=extract '.status' "$RESEARCH_ROOT/q/report.md")" = draft ]
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "add records a new type in a draft brief and sets its updated date" {
	new_research
	RESEARCH_TODAY=2026-11-09 run "$R" add q experiment --title X --author A
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = comparison,experiment ]
	[ "$(yq --front-matter=extract '.updated' "$RESEARCH_ROOT/q/brief.md")" = 2026-11-09 ]
}

@test "add leaves the brief alone for a type that it requests already" {
	new_research
	RESEARCH_TODAY=2026-11-09 run "$R" add q comparison --name second --title X --author A
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$RESEARCH_ROOT/q/brief.md")" = comparison ]
	[ "$(yq --front-matter=extract '.updated' "$RESEARCH_ROOT/q/brief.md")" = 2026-11-06 ]
}

@test "add refuses a type that a brief in review does not request" {
	new_research
	swap "$RESEARCH_ROOT/q/brief.md" "status: draft" "status: review"
	run "$R" add q experiment --title X --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"The brief does not request the type experiment, and it is past draft."* ]] || false
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
	run ! grep -q '^### S' "$RESEARCH_ROOT/q/sources.md"
}

@test "source add writes the fields in a fixed order, with the archive before the evidence" {
	new_research
	run "$R" source add q --kind secondary --author "Ann Lee" --title Queues --url https://example.com/q \
		--evidence "Fourteen days." --published 2025-01-02 --archive https://web.archive.org/web/1/https://example.com/q
	[ "$status" -eq 0 ]
	[ "$output" = S1 ]
	[ "$(sed -n '/^### S1$/,$p' "$RESEARCH_ROOT/q/sources.md")" = "$(printf '%s\n' '### S1' '' \
		'| Field | Value |' '| --- | --- |' '| kind | secondary |' '| author | Ann Lee |' '| title | Queues |' \
		'| url | https://example.com/q |' '| published | 2025-01-02 |' '| accessed | 2026-11-06 |' \
		'| archive | https://web.archive.org/web/1/https://example.com/q |' '| evidence | Fourteen days. |')" ]
}

@test "source add sets published to unknown by default and leaves out an absent archive" {
	new_research
	"$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence E >/dev/null
	grep -qxF '| published | unknown |' "$RESEARCH_ROOT/q/sources.md"
	run ! grep -q '^| archive |' "$RESEARCH_ROOT/q/sources.md"
}

@test "source add starts a new line when the register does not end with one" {
	new_research
	printf 'A note without a final newline' >>"$RESEARCH_ROOT/q/sources.md"
	"$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence E >/dev/null
	# A blank line separates the entry from the note.
	[ -z "$(awk '/^### S1$/ { print prev } { prev = $0 }' "$RESEARCH_ROOT/q/sources.md")" ]
	grep -qx 'A note without a final newline' "$RESEARCH_ROOT/q/sources.md"
}

@test "source add sets the updated date of the register, but not for a known url" {
	new_research
	RESEARCH_TODAY=2026-11-09 "$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence E >/dev/null
	[ "$(yq --front-matter=extract '.updated' "$RESEARCH_ROOT/q/sources.md")" = 2026-11-09 ]
	cp "$RESEARCH_ROOT/q/sources.md" "$BATS_TEST_TMPDIR/before"
	RESEARCH_TODAY=2026-11-10 run "$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence E
	[ "$status" -eq 0 ]
	[[ "$output" == *"The register holds this url already as S1."* ]] || false
	cmp "$BATS_TEST_TMPDIR/before" "$RESEARCH_ROOT/q/sources.md"
}

@test "source add refuses a bad archive, an empty author or title and an empty evidence, and writes nothing" {
	new_research
	cp "$RESEARCH_ROOT/q/sources.md" "$BATS_TEST_TMPDIR/before"
	run "$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence E --archive web.archive.org/a
	[ "$status" -eq 2 ]
	[[ "$output" == *"--archive must start with http:// or https://."* ]] || false
	run "$R" source add q --kind primary --author "" --title T --url https://example.com/a --evidence E
	[ "$status" -eq 2 ]
	[ "$output" = "--author must not be empty." ]
	run "$R" source add q --kind primary --author A --title "" --url https://example.com/a --evidence E
	[ "$status" -eq 2 ]
	[ "$output" = "--title must not be empty." ]
	run "$R" source add q --kind primary --author A --title T --url https://example.com/a --evidence ""
	[ "$status" -eq 2 ]
	[ "$output" = "--evidence must not be empty." ]
	cmp "$BATS_TEST_TMPDIR/before" "$RESEARCH_ROOT/q/sources.md"
}

@test "source add refuses a research without a register and a bad slug" {
	run "$R" source add nosuch --kind primary --author A --title T --url https://example.com/a --evidence E
	[ "$status" -eq 1 ]
	[ "$output" = "No $RESEARCH_ROOT/nosuch/sources.md. Run research.sh init first." ]
	run "$R" source add Bad_Slug --kind primary --author A --title T --url https://example.com/a --evidence E
	[ "$status" -eq 2 ]
	[[ "$output" == *"The slug 'Bad_Slug' must be kebab-case."* ]] || false
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
	[[ "$output" == *"cites sources that are not in sources.md: S9."* ]] || false
	cmp "$BATS_TEST_TMPDIR/before" "$V/report.md"
}

@test "cite sync ignores citations in code and comments" {
	new_research
	"$R" source add q --kind primary --author A --title One --url https://example.com/a --evidence E >/dev/null
	# The template cites [^S1] in a comment. Add a fenced block and inline code.
	swap "$RESEARCH_ROOT/q/report.md" "## Analysis" $'## Analysis\n\n```text\nOne.[^S1]\n```\n\nSee `[^S1]`.'
	cp "$RESEARCH_ROOT/q/report.md" "$BATS_TEST_TMPDIR/report"
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	cmp "$BATS_TEST_TMPDIR/report" "$RESEARCH_ROOT/q/report.md"
}

@test "cite sync updates every file that cites a source, lists them and leaves the register alone" {
	new_research
	"$R" add q comparison --title X --author A >/dev/null
	"$R" source add q --kind primary --author A --title One --url https://example.com/a --evidence E >/dev/null
	"$R" source add q --kind primary --author B --title Two --url https://example.com/b --evidence E >/dev/null
	swap "$RESEARCH_ROOT/q/report.md" "## Analysis" $'## Analysis\n\nOne.[^S1]'
	swap "$RESEARCH_ROOT/q/comparison.md" "## Options" $'## Options\n\nTwo.[^S2]'
	cp "$RESEARCH_ROOT/q/sources.md" "$BATS_TEST_TMPDIR/register"
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' "$RESEARCH_ROOT/q/comparison.md" "$RESEARCH_ROOT/q/report.md")" ]
	cmp "$BATS_TEST_TMPDIR/register" "$RESEARCH_ROOT/q/sources.md"
}

@test "cite sync removes a definition that no text cites any more" {
	swap "$V/report.md" "to a git revision.[^S1]" "to a git revision."
	run "$R" cite sync hook-runner-choice
	[ "$status" -eq 0 ]
	[ "$output" = "$V/report.md" ]
	run ! grep -q '^\[\^S1\]:' "$V/report.md"
	grep -q '^\[\^S2\]:' "$V/report.md"
}

@test "cite sync orders the definitions by number, not by text" {
	new_research
	"$R" source add q --kind primary --author A --title One --url https://example.com/a --evidence E >/dev/null
	"$R" source add q --kind primary --author B --title Two --url https://example.com/b --evidence E >/dev/null
	perl -0pi -e 's/### S1\n/### S10\n/' "$RESEARCH_ROOT/q/sources.md"
	swap "$RESEARCH_ROOT/q/report.md" "## Analysis" $'## Analysis\n\nTen.[^S10] Two.[^S2]'
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ "$(tail -n 2 "$RESEARCH_ROOT/q/report.md")" = "$(printf '%s\n' '[^S2]: [S2](sources.md#s2) B, Two.' '[^S10]: [S10](sources.md#s10) A, One.')" ]
}

@test "cite sync keeps a definition-like line inside a code block" {
	new_research
	"$R" source add q --kind primary --author A --title One --url https://example.com/a --evidence E >/dev/null
	swap "$RESEARCH_ROOT/q/report.md" "## Analysis" $'## Analysis\n\nOne.[^S1]\n\n```text\n[^S1]: this is an example\n```'
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	grep -qx '\[\^S1\]: this is an example' "$RESEARCH_ROOT/q/report.md"
	[ "$(tail -n 1 "$RESEARCH_ROOT/q/report.md")" = '[^S1]: [S1](sources.md#s1) A, One.' ]
}

@test "cite sync still fixes the later files when an earlier file cites an unknown ID" {
	# comparison.md comes before report.md, so the stop would hide report.md.
	swap "$V/comparison.md" "a Go binary that runs hook commands.[^S2]" "a Go binary that runs hook commands.[^S9]"
	sed '$d' "$V/report.md" >"$BATS_TEST_TMPDIR/r.md"
	cp "$BATS_TEST_TMPDIR/r.md" "$V/report.md"
	run "$R" cite sync hook-runner-choice
	[ "$status" -eq 1 ]
	[[ "$output" == *"$V/comparison.md: cites sources that are not in sources.md: S9."* ]] || false
	[[ "$output" == *"$V/report.md"* ]] || false
	run "$R" check hook-runner-choice
	[[ "$output" != *"report.md"* ]] || false
}

@test "cite sync refuses a research without a register and a bad slug" {
	run "$R" cite sync nosuch
	[ "$status" -eq 1 ]
	[ "$output" = "No $RESEARCH_ROOT/nosuch/sources.md. Run research.sh init first." ]
	run "$R" cite sync Bad_Slug
	[ "$status" -eq 2 ]
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
	[[ "$output" == *"cannot move from draft to final"* ]] || false
	cp "$RESEARCH_ROOT/q/report.md" "$BATS_TEST_TMPDIR/before"
	run "$R" status q report.md review
	[ "$status" -eq 1 ]
	[[ "$output" == *"but brief.md is draft."* ]] || false
	[[ "$output" == *"The status stays draft."* ]] || false
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

@test "status prints the file and the move it made" {
	new_research
	fill_brief
	run "$R" status q brief.md review
	[ "$status" -eq 0 ]
	[ "$output" = "$RESEARCH_ROOT/q/brief.md: draft > review" ]
}

@test "status allows only draft to review, review to draft, review to final and final to superseded" {
	new_research
	for pair in draft:draft draft:final draft:superseded review:review review:superseded final:draft \
		final:review final:final superseded:draft superseded:review superseded:final superseded:superseded; do
		old=${pair%%:*}
		new=${pair#*:}
		perl -pi -e "s/^status: .*/status: $old/" "$RESEARCH_ROOT/q/brief.md"
		run "$R" status q brief.md "$new"
		[ "$status" -eq 1 ] || {
			echo "$old > $new: exit $status"
			return 1
		}
		[[ "$output" == *"brief.md cannot move from $old to $new."* ]] || {
			echo "$old > $new: output '$output'"
			return 1
		}
		[ "$(yq --front-matter=extract '.status' "$RESEARCH_ROOT/q/brief.md")" = "$old" ]
	done
}

@test "status moves a file from review back to draft without a check" {
	new_research
	swap "$RESEARCH_ROOT/q/report.md" "status: draft" "status: review"
	run "$R" check q
	[ "$status" -eq 1 ]
	run "$R" status q report.md draft
	[ "$status" -eq 0 ]
	[ "$output" = "$RESEARCH_ROOT/q/report.md: review > draft" ]
}

@test "status refuses a status that is none of the four, a missing file and a bad slug" {
	new_research
	run "$R" status q brief.md done
	[ "$status" -eq 2 ]
	[[ "$output" == *"The status must be one of: draft review final superseded."* ]] || false
	run "$R" status q nofile.md review
	[ "$status" -eq 1 ]
	[ "$output" = "No $RESEARCH_ROOT/q/nofile.md." ]
	run "$R" status Bad_Slug brief.md review
	[ "$status" -eq 2 ]
}

@test "status takes --by for superseded only, and only the slug of another research" {
	new_research
	fill_brief
	"$R" status q brief.md review >/dev/null
	run "$R" status q brief.md final --by cache-layer
	[ "$status" -eq 2 ]
	[ "$output" = "--by applies only to superseded." ]
	run "$R" status hook-runner-choice recommendation.md superseded --by hook-runner-choice
	[ "$status" -eq 2 ]
	run "$R" status hook-runner-choice recommendation.md superseded --by nosuch
	[ "$status" -eq 2 ]
	[ "$output" = "superseded needs --by with the slug of another research." ]
	[ "$(yq --front-matter=extract '.status' "$V/recommendation.md")" = final ]
}

@test "status lets the brief move while another artifact is a draft with problems" {
	new_research
	"$R" add q comparison --title X --author A >/dev/null
	grep -v '^## Options' "$RESEARCH_ROOT/q/comparison.md" >"$BATS_TEST_TMPDIR/c.md"
	cp "$BATS_TEST_TMPDIR/c.md" "$RESEARCH_ROOT/q/comparison.md"
	run "$R" check q
	[ "$status" -eq 1 ]
	fill_brief
	run "$R" status q brief.md review
	[ "$status" -eq 0 ]
}

@test "status refuses a move while the folder lacks a required file" {
	new_research
	fill_brief
	rm "$RESEARCH_ROOT/q/sources.md"
	run "$R" status q brief.md review
	[ "$status" -eq 1 ]
	[[ "$output" == *"$RESEARCH_ROOT/q: the required file sources.md is missing."* ]] || false
	[[ "$output" == *"The status stays draft. Fix the problems above first."* ]] || false
	[ "$(yq --front-matter=extract '.status' "$RESEARCH_ROOT/q/brief.md")" = draft ]
}

# ------------------------------------------------------ sub-slugs and progress

# Print a checksum of every file below the folder $1, except the subfolder
# $2 when it is given.
tree_sum() {
	(cd "$1" && find . ${2:+-path "./$2" -prune -o} -type f -print | LC_ALL=C sort | xargs cksum)
}

# Set the status line of the file $1 to $2, by hand.
set_status() {
	swap "$1" "status: $(yq --front-matter=extract '.status' "$1")" "status: $2"
}

@test "progress prints the files, the placeholders, the sources and the sub-slugs of a parent" {
	run "$R" progress hook-runner-choice
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' \
		"research: hook-runner-choice" \
		"parent: none" \
		"files:" \
		"  brief.md: final" \
		"  comparison.md: final" \
		"  experiment-install-time.md: final" \
		"  recommendation.md: final" \
		"  report.md: final" \
		"  sources.md: final" \
		"  tech-profile-lefthook.md: final" \
		"placeholders: none" \
		"sources: 4" \
		"sub-slugs:" \
		"  ci-cache (report: final)")" ]
}

@test "progress of a sub-slug names its parent and lists each open placeholder" {
	run "$R" progress cache-layer/redis-cluster
	[ "$status" -eq 0 ]
	[ "${lines[0]}" = "research: cache-layer/redis-cluster" ]
	[ "${lines[1]}" = "parent: cache-layer (report: draft)" ]
	[[ "$output" == *$'\nplaceholders:\n  brief.md:24\n'* ]] || false
	[ "$(grep -c '^  report.md:[0-9]*$' <<<"$output")" -eq 6 ]
	[ "${lines[${#lines[@]} - 2]}" = "sources: 0" ]
	[ "${lines[${#lines[@]} - 1]}" = "sub-slugs: none" ]
}

@test "progress counts the sources after source add, and reports a missing register or report" {
	"$R" source add cache-layer/redis-cluster --kind primary --author A --title T \
		--url https://example.com/a --evidence E >/dev/null
	run "$R" progress cache-layer/redis-cluster
	[[ "$output" == *$'\nsources: 1\n'* ]] || false
	rm "$RESEARCH_ROOT/cache-layer/redis-cluster/sources.md" "$RESEARCH_ROOT/cache-layer/redis-cluster/report.md"
	run "$R" progress cache-layer
	[[ "$output" == *$'\n  redis-cluster (report: missing)'* ]] || false
	run "$R" progress cache-layer/redis-cluster
	[[ "$output" == *$'\nsources: no sources.md\n'* ]] || false
}

@test "progress writes nothing" {
	before=$(tree_sum "$RESEARCH_ROOT")
	"$R" progress hook-runner-choice >/dev/null
	"$R" progress cache-layer/redis-cluster >/dev/null
	[ "$(tree_sum "$RESEARCH_ROOT")" = "$before" ]
}

@test "progress exits 1 for a research that does not exist, and 2 for a bad slug" {
	run "$R" progress nope
	[ "$status" -eq 1 ]
	[[ "$output" == *"No research nope."* ]] || false
	run "$R" progress cache-layer/nope
	[ "$status" -eq 1 ]
	for slug in Bad_Slug a/b/c cache-layer/ /cache-layer; do
		run "$R" progress "$slug"
		[ "$status" -eq 2 ] || {
			echo "$slug: exit $status"
			return 1
		}
	done
}

@test "reopen moves the final brief and every review or final file to draft, and sets the date" {
	set_status "$V/comparison.md" review
	run "$R" reopen hook-runner-choice
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -eq 7 ]
	[[ "$output" == *"$V/comparison.md: review > draft"* ]] || false
	[[ "$output" == *"$V/brief.md: final > draft"* ]] || false
	for file in "$V"/*.md; do
		[ "$(yq --front-matter=extract '.status' "$file")" = draft ]
		[ "$(yq --front-matter=extract '.updated' "$file")" = 2026-11-06 ]
	done
}

@test "reopen keeps the source IDs and every register row" {
	before=$(grep -vE '^(status|updated):' "$V/sources.md")
	"$R" reopen hook-runner-choice >/dev/null
	[ "$(grep -vE '^(status|updated):' "$V/sources.md")" = "$before" ]
	run "$R" source add hook-runner-choice --kind primary --author A --title T \
		--url https://example.com/new --evidence E
	[ "$output" = S5 ]
}

@test "reopen keeps a superseded file, and the reopened research still passes the check" {
	report="$RESEARCH_ROOT/hook-runner-first-look/report.md"
	before=$(cksum <"$report")
	run "$R" reopen hook-runner-first-look
	[ "$status" -eq 0 ]
	[ "$(cksum <"$report")" = "$before" ]
	[ "${#lines[@]}" -eq 2 ]
	problems hook-runner-first-look
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "a final file still needs a final brief after reopen" {
	"$R" reopen hook-runner-first-look >/dev/null
	set_status "$RESEARCH_ROOT/hook-runner-first-look/sources.md" final
	problems hook-runner-first-look
	[ "$status" -eq 1 ]
	[ "$output" = "hook-runner-first-look/sources.md: the status is final, but brief.md is draft. Get the approval of the user and run: research.sh status hook-runner-first-look brief.md final" ]
}

@test "reopen leaves the sub-slugs of a parent and the parent of a sub-slug unchanged" {
	child=$(tree_sum "$V/ci-cache")
	"$R" reopen hook-runner-choice >/dev/null
	[ "$(tree_sum "$V/ci-cache")" = "$child" ]
	parent=$(tree_sum "$V" ci-cache)
	run "$R" reopen hook-runner-choice/ci-cache
	[ "$status" -eq 0 ]
	[ "${#lines[@]}" -eq 3 ]
	[ "$(tree_sum "$V" ci-cache)" = "$parent" ]
}

@test "reopen refuses a research whose brief is not final, and changes nothing" {
	before=$(tree_sum "$RESEARCH_ROOT")
	run "$R" reopen cache-layer
	[ "$status" -eq 1 ]
	[[ "$output" == *"The brief of cache-layer is draft, not final."* ]] || false
	[[ "$output" == *"research.sh status cache-layer <file> draft"* ]] || false
	new_research
	fill_brief
	"$R" status q brief.md review >/dev/null
	before=$(tree_sum "$RESEARCH_ROOT")
	run "$R" reopen q
	[ "$status" -eq 1 ]
	[[ "$output" == *"is review, not final."* ]] || false
	[ "$(tree_sum "$RESEARCH_ROOT")" = "$before" ]
}

@test "reopen exits 1 for a research without a brief, and 2 for a bad slug" {
	run "$R" reopen nope
	[ "$status" -eq 1 ]
	run "$R" reopen a/b/c
	[ "$status" -eq 2 ]
}

@test "after reopen, the user approves the brief again and the flow goes on" {
	"$R" reopen hook-runner-choice >/dev/null
	echo "- New requirement: Windows support." >>"$V/brief.md"
	run "$R" status hook-runner-choice brief.md review
	[ "$status" -eq 0 ]
	run "$R" status hook-runner-choice brief.md final
	[ "$status" -eq 0 ]
	run "$R" status hook-runner-choice report.md review
	[ "$status" -eq 0 ]
}

@test "status refuses final to draft, also for a sub-slug, and points to reopen" {
	for slug in hook-runner-choice hook-runner-choice/ci-cache; do
		run "$R" status "$slug" brief.md draft
		[ "$status" -eq 1 ]
		[[ "$output" == *"brief.md cannot move from final to draft. To continue an approved research, run: research.sh reopen $slug"* ]] || false
	done
	[ "$(yq --front-matter=extract '.status' "$V/brief.md")" = final ]
}

@test "status keeps a parent report in draft while it does not link a sub-slug" {
	"$R" reopen hook-runner-choice >/dev/null
	"$R" status hook-runner-choice brief.md review >/dev/null
	"$R" status hook-runner-choice brief.md final >/dev/null
	swap "$V/report.md" "(ci-cache/report.md)" "(ci-cache/)"
	run "$R" status hook-runner-choice report.md review
	[ "$status" -eq 1 ]
	[[ "$output" == *"report.md: the report does not link the sub-slug research 'ci-cache'."* ]] || false
	[ "$(yq --front-matter=extract '.status' "$V/report.md")" = draft ]
	swap "$V/report.md" "(ci-cache/)" "(./ci-cache/report.md#summary)"
	run "$R" status hook-runner-choice report.md review
	[ "$status" -eq 0 ]
}

@test "the problems of a sub-slug do not block a move in its parent, and the reverse" {
	swap "$V/ci-cache/report.md" "authors:" "owner: x"$'\n'"authors:"
	"$R" reopen hook-runner-choice >/dev/null
	run "$R" status hook-runner-choice brief.md review
	[ "$status" -eq 0 ]
	swap "$V/ci-cache/report.md" "owner: x"$'\n' ""
	swap "$V/recommendation.md" "authors:" "owner: x"$'\n'"authors:"
	"$R" reopen hook-runner-choice/ci-cache >/dev/null
	run "$R" status hook-runner-choice/ci-cache brief.md review
	[ "$status" -eq 0 ]
}

@test "status supersedes a file by a sub-slug, and refuses a slug two levels deep" {
	run "$R" status hook-runner-choice recommendation.md superseded --by cache-layer/a/b
	[ "$status" -eq 2 ]
	run "$R" status hook-runner-choice recommendation.md superseded --by cache-layer/redis-cluster
	[ "$status" -eq 0 ]
	[ "$(yq --front-matter=extract '.superseded_by' "$V/recommendation.md")" = cache-layer/redis-cluster ]
	problems
	[ "$status" -eq 0 ]
}

@test "init of a sub-slug creates the child research and leaves the parent unchanged" {
	before=$(tree_sum "$RESEARCH_ROOT/cache-layer")
	run --separate-stderr "$R" init cache-layer/eviction --title "Eviction" --author "Ann Lee"
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' \
		"$RESEARCH_ROOT/cache-layer/eviction/brief.md" \
		"$RESEARCH_ROOT/cache-layer/eviction/report.md" \
		"$RESEARCH_ROOT/cache-layer/eviction/sources.md")" ]
	[ -z "$stderr" ]
	[ "$(tree_sum "$RESEARCH_ROOT/cache-layer" eviction)" = "$before" ]
	problems cache-layer/eviction
	[ "$status" -eq 0 ]
}

@test "init of a sub-slug below a parent report in review or later says that the parent must link it" {
	before=$(tree_sum "$V")
	run --separate-stderr "$R" init hook-runner-choice/windows --title "Windows" --author "Ann Lee"
	[ "$status" -eq 0 ]
	[[ "$stderr" == *"The report of hook-runner-choice is final, so the check now wants a link to windows/report.md in it."* ]] || false
	[[ "$stderr" == *"research.sh reopen hook-runner-choice"* ]] || false
	[ "$(tree_sum "$V" windows)" = "$before" ]
	problems hook-runner-choice
	[ "$output" = "hook-runner-choice/report.md: the report does not link the sub-slug research 'windows'. Add a link to windows/report.md, such as [<title>](windows/report.md)." ]
}

@test "init of a sub-slug fails when the parent does not exist, and creates nothing" {
	run "$R" init queue/sqs --title T --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"No research queue. Run research.sh init queue first"* ]] || false
	[ ! -e "$RESEARCH_ROOT/queue" ]
}

@test "init refuses a slug two levels deep and a sub-slug that is not kebab-case" {
	for slug in cache-layer/a/b cache-layer/ /cache-layer cache-layer/Bad_Name cache-layer//a; do
		run "$R" init "$slug" --title T --author A
		[ "$status" -eq 2 ] || {
			echo "$slug: exit $status"
			return 1
		}
		[[ "$output" == *"must be kebab-case. Use <slug> or <slug>/<sub-slug>."* ]] || false
	done
	[ "$(find "$RESEARCH_ROOT/cache-layer" -mindepth 1 -type d | wc -l | tr -d ' ')" -eq 1 ]
}

@test "add, source add and cite sync work on a sub-slug and touch only its folder" {
	C="$RESEARCH_ROOT/cache-layer/redis-cluster"
	parent=$(tree_sum "$RESEARCH_ROOT/cache-layer" redis-cluster)
	run "$R" add cache-layer/redis-cluster comparison --title "Cluster options" --author "Ann Lee"
	[ "$status" -eq 0 ]
	[ "$output" = "$C/comparison.md" ]
	[ "$(yq --front-matter=extract '.artifacts[]' "$C/brief.md")" = comparison ]
	run "$R" source add cache-layer/redis-cluster --kind primary --author "Redis Ltd." \
		--title "Redis cluster specification" --url https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/ \
		--evidence "Redis cluster splits the keys into hash slots."
	[ "$output" = S1 ]
	swap "$C/report.md" "## Key findings" "## Key findings"$'\n\n'"- Redis cluster uses hash slots.[^S1]"
	run "$R" cite sync cache-layer/redis-cluster
	[ "$status" -eq 0 ]
	grep -qxF "[^S1]: [S1](sources.md#s1) Redis Ltd., Redis cluster specification." "$C/report.md"
	[ "$(tree_sum "$RESEARCH_ROOT/cache-layer" redis-cluster)" = "$parent" ]
}

@test "check of a parent covers its sub-slugs, and check of a sub-slug covers only that sub-slug" {
	swap "$V/ci-cache/report.md" "authors:" "owner: x"$'\n'"authors:"
	swap "$V/recommendation.md" "authors:" "owner: x"$'\n'"authors:"
	problems hook-runner-choice
	[ "$status" -eq 1 ]
	[ "$(grep -c "front matter key 'owner'" <<<"$output")" -eq 2 ]
	problems hook-runner-choice/ci-cache
	[ "$status" -eq 1 ]
	[[ "$output" == "hook-runner-choice/ci-cache/report.md: front matter key 'owner'"* ]] || false
	[ "$(wc -l <<<"$output" | tr -d ' ')" -eq 1 ]
}

@test "check takes the path of a sub-slug folder and gives fix hints with the full slug" {
	rm "$V/ci-cache/sources.md"
	run "$R" check "$V/ci-cache"
	[ "$status" -eq 1 ]
	[[ "$output" == *"Run: research.sh add hook-runner-choice/ci-cache sources --title <t> --author <a>"* ]] || false
}

@test "check reports a folder two levels below a parent, also when it is given as a slug" {
	mkdir -p "$V/ci-cache/deep"
	problems hook-runner-choice/ci-cache/deep
	[ "$status" -eq 1 ]
	[ "$output" = "hook-runner-choice/ci-cache/deep: the folder is nested deeper than <slug>/<sub-slug>. Sub-slugs go one level deep only. Move it up to a child research of its own, or delete it." ]
}

@test "a link to a sub-slug in a code block or a comment does not count" {
	swap "$V/report.md" "[Cache of hook environments in CI](ci-cache/report.md)" '`[CI cache](ci-cache/report.md)`'
	problems hook-runner-choice
	[[ "$output" == *"does not link the sub-slug research 'ci-cache'"* ]] || false
	swap "$V/report.md" '`[CI cache](ci-cache/report.md)`' '<!-- [CI cache](ci-cache/report.md) -->'
	problems hook-runner-choice
	[[ "$output" == *"does not link the sub-slug research 'ci-cache'"* ]] || false
}

@test "a parent report in draft needs no link to its sub-slugs" {
	problems cache-layer
	[ "$status" -eq 0 ]
	[ -d "$RESEARCH_ROOT/cache-layer/redis-cluster" ]
}

# ------------------------------------------------------------- init --issue

# Make the fake gh serve issue 50 of the Research form: the title, the
# labels of $1 (default type:research) and the body on stdin, with the CRLF
# line ends that the web form writes. Call it with < <(...), not in a
# pipe, so the fake stays on PATH.
issue_reply() {
	fake_gh
	jq -Rs --arg labels "${1:-type:research}" '{title: "Queue choice", url: "https://github.com/o/r/issues/50",
		labels: ($labels | split(",") | map({name: .})), body: gsub("\n"; "\r\n")}' | gh_reply "issue view"
}

# The body of a Research issue. $1 is the depth, $2 the slug.
issue_body() {
	cat <<-EOF2
	### Scope

	agents

	### Question

	Which queue should carry the order events?

	### Background

	The order service polls a table today.

	It loses events on a restart.

	### In scope

	- SQS
	- Kafka

	### Out of scope

	_No response_

	### Constraints

	_No response_

	### Done when

	- [ ] Each queue has a cost estimate.

	### Depth

	${1:-deep}

	### Artifacts

	- [x] comparison
	- [ ] recommendation
	- [ ] tech-profile
	- [x] experiment

	### Source policy

	_No response_

	### Slug

	${2:-_No response_}
	EOF2
}

@test "init --issue writes the title, depth, artifacts and brief sections from the issue" {
	issue_reply < <(issue_body deep q)
	run "$R" init q --issue 50 --author "Ann Lee"
	[ "$status" -eq 0 ]
	[[ "$(calls)" == "gh issue view 50 --json title,body,labels,url" ]] || false
	b="$RESEARCH_ROOT/q/brief.md"
	[ "$(yq --front-matter=extract '.title' "$b")" = "Queue choice" ]
	[ "$(yq --front-matter=extract '.depth' "$b")" = deep ]
	[ "$(yq --front-matter=extract '.artifacts | join(",")' "$b")" = comparison,experiment ]
	grep -qx '# Queue choice' "$RESEARCH_ROOT/q/report.md"
	expected=$(cat <<-EOF2
	## Question

	Which queue should carry the order events?

	## Background

	The order service polls a table today.

	It loses events on a restart.

	Requested in issue [#50](https://github.com/o/r/issues/50).

	## Scope

	### In scope

	- SQS
	- Kafka
	EOF2
	)
	[[ "$(cat "$b")" == *"$expected"* ]] || false
	grep -qx -- '- \[ \] Each queue has a cost estimate.' "$b"
	[[ "$(cat "$b")" != *$'\r'* ]] || false
	run "$R" check q
	[ "$status" -eq 0 ]
}

@test "init --issue keeps the fill comment of a field without a response" {
	issue_reply < <(issue_body)
	"$R" init q --issue 50 --author A >/dev/null
	b="$RESEARCH_ROOT/q/brief.md"
	for heading in "### Out of scope" "## Constraints" "## Source policy"; do
		[ "$(grep -A2 -x -- "$heading" "$b" | tail -1 | cut -c1-10)" = '<!-- fill:' ]
	done
	[ "$(grep -c '_No response_' "$b")" -eq 0 ]
}

@test "init --issue takes a --title in place of the issue title" {
	issue_reply < <(issue_body)
	"$R" init q --issue 50 --title "Order queue" --author A >/dev/null
	[ "$(yq --front-matter=extract '.title' "$RESEARCH_ROOT/q/brief.md")" = "Order queue" ]
}

@test "init --issue refuses an issue without the type:research label, and creates nothing" {
	issue_reply "type:chore,scope:agents" < <(issue_body)
	run "$R" init q --issue 50 --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #50 has no type:research label."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "init --issue refuses a bad depth, an unknown artifact and another slug" {
	issue_reply < <(issue_body shallow)
	run "$R" init q --issue 50 --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #50: the Depth section must be one of: quick standard deep."* ]] || false
	issue_reply < <(issue_body | sed 's/\[x\] experiment/[x] essay/')
	run "$R" init q --issue 50 --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #50: the artifact essay is not one of:"* ]] || false
	issue_reply < <(issue_body deep other-slug)
	run "$R" init q --issue 50 --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #50 names the slug other-slug, not q."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "init --issue exits 1 when gh cannot read the issue" {
	fake_gh
	gh_reply "issue view" 1 </dev/null
	run "$R" init q --issue 50 --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"gh could not read issue #50."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "init --issue refuses --depth, --artifact and an issue that is not a number, before it calls gh" {
	guard_fakes
	run "$R" init q --issue 50 --author A --depth quick
	[ "$status" -eq 2 ]
	[[ "$output" == *"--depth comes from the issue"* ]] || false
	run "$R" init q --artifact comparison --issue 50 --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"--artifact comes from the issue"* ]] || false
	run "$R" init q --issue 5x --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"--issue must be an issue number."* ]] || false
	usage_error init q --author A --issue
	[ -z "$(calls)" ]
}

@test "init on an existing research points to its progress" {
	new_research
	run "$R" init q --title T --author A
	[ "$status" -eq 1 ]
	[[ "$output" == *"To continue that research, run research.sh progress q first."* ]] || false
}
