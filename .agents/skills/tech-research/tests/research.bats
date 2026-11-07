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
		"status <slug> <file> <status>" "check [<slug>...]"; do
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

@test "a bad RESEARCH_TODAY exits 2 before an action writes a file" {
	RESEARCH_TODAY=06.11.2026 run "$R" init q --title T --author A
	[ "$status" -eq 2 ]
	[[ "$output" == *"RESEARCH_TODAY must have the form YYYY-MM-DD."* ]] || false
	[ ! -e "$RESEARCH_ROOT/q" ]
}

@test "a bad RESEARCH_TODAY stops each action that writes, and changes no file" {
	new_research
	before=$(find "$RESEARCH_ROOT" -type f -exec cksum {} + | sort)
	for args in "add q report" "source add q" "cite sync q" "status q brief.md review"; do
		RESEARCH_TODAY=bad run "$R" $args
		[ "$status" -eq 2 ] || {
			echo "$args: exit $status"
			return 1
		}
		[[ "$output" == *"RESEARCH_TODAY must have the form YYYY-MM-DD."* ]] || false
	done
	[ "$(find "$RESEARCH_ROOT" -type f -exec cksum {} + | sort)" = "$before" ]
}

@test "check and the usage ignore RESEARCH_TODAY, because they write no date" {
	RESEARCH_TODAY=bad run "$R" check
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
	[[ "$output" == *"with the folder name of the research that replaces this file: none."* ]] || false
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
	run "$R" cite sync q
	[ "$status" -eq 0 ]
	[ -z "$output" ]
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
