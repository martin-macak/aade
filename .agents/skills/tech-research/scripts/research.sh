#!/usr/bin/env bash

# The tech-research tool. It does every action on a research folder that
# must give the same result each time: it creates the folder and the typed
# artifacts from the templates, adds sources to the register, writes the
# footnote definitions, moves the status, and checks the folder. The
# tech-research skill explains the format.
#
# Usage:
#   research.sh init <slug> --title <t> --author <a>... [--depth <d>] [--artifact <type>]...
#   research.sh init <slug> --issue <n> [--title <t>] --author <a>...
#       (the brief, depth and artifacts from a type:research issue)
#   research.sh add <slug> <type> [--name <n>] --title <t> --author <a>...
#       (a required type only when its file is missing)
#   research.sh source add <slug> --kind <k> --author <a> --title <t> --url <u>
#       --evidence <e> [--published <yyyy-mm-dd>] [--archive <url>]
#   research.sh cite sync <slug>
#   research.sh status <slug> <file> <status> [--by <slug>]
#   research.sh check [<slug>...]
#   research.sh progress <slug>
#   research.sh reopen <slug>
#
# A <slug> is the folder name of a research, or <slug>/<sub-slug> for a
# child research in a subfolder of its parent. Only one level is allowed.
# Run it from the repository root. RESEARCH_ROOT sets the research folder
# (default docs/research). RESEARCH_TODAY sets the date in YYYY-MM-DD form
# (default: the current date), so tests get fixed dates.
# It needs yq and jq, gh for init --issue, and runs on bash 3.2.
# Exit codes: 0 done or no problem found, 1 a check failed or a value was
# refused, 2 a usage error.

set -u -o pipefail

SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
TYPES_FILE="$SKILL_DIR/references/types.yml"
TEMPLATES="$SKILL_DIR/references/templates"
ROOT_DIR=${RESEARCH_ROOT:-docs/research}
STATUSES="draft review final superseded"
KINDS="primary secondary tertiary"
DEPTHS="quick standard deep"
SOURCE_KEYS="kind author title url published accessed archive evidence"
# The front matter keys of every artifact, of a brief, and of a superseded
# artifact. No other key is allowed, so the schema stays closed.
FRONT_KEYS="type title status created updated authors"
BRIEF_KEYS="depth artifacts"
SUPERSEDED_KEYS="superseded_by"
# A complete file claims an answer, so the completeness rules apply to it.
COMPLETE="review final superseded"
SLUG_RE='^[a-z0-9]+(-[a-z0-9]+)*$'
SLUG_PATH_RE='^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)?$'
DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
URL_RE='^https?://[^[:space:]]+$'
FENCE='```'
# init --issue reads an issue of the Research form in
# .github/ISSUE_TEMPLATE/research.yml. Each "### <label>" section of its
# body fills one brief section: <form label>=<brief heading>, split by ";".
# The Depth, Artifacts and Slug sections set the front matter and the slug.
# The drift test compares these labels with the form.
ISSUE_LABEL="type:research"
ISSUE_SECTIONS="Question=## Question;Background=## Background;In scope=### In scope;Out of scope=### Out of scope;Constraints=## Constraints;Done when=## Success criteria;Source policy=## Source policy"
ISSUE_DEPTH="Depth"
ISSUE_ARTIFACTS="Artifacts"
ISSUE_SLUG="Slug"

usage() {
	{ sed -n '/^# Usage:/,/^# Run it/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; } >&2
	exit 2
}

die() {
	>&2 echo "$1"
	exit "${2:-1}"
}

today() {
	local day=${RESEARCH_TODAY:-$(date +%F)}
	[[ "$day" =~ $DATE_RE ]] || die "RESEARCH_TODAY must have the form YYYY-MM-DD." 2
	echo "$day"
}

# Succeed when $1 is one of the other arguments.
one_of() {
	local value=$1 item
	shift
	for item in "$@"; do
		[[ "$item" == "$value" ]] && return 0
	done
	return 1
}

# The types of types.yml, read once by load_types: every name in file
# order, and the names with required true, required false, repeatable true
# and diagram true. A check reads them many times, and a yq call per read
# made it slow.
TYPE_NAMES="" TYPE_REQUIRED="" TYPE_OPTIONAL="" TYPE_REPEATABLE="" TYPE_DIAGRAM=""
load_types() {
	local name required repeatable diagram
	while read -r name required repeatable diagram; do
		TYPE_NAMES+=" $name"
		case $required in
		true) TYPE_REQUIRED+=" $name" ;;
		false) TYPE_OPTIONAL+=" $name" ;;
		esac
		[[ "$repeatable" != true ]] || TYPE_REPEATABLE+=" $name"
		[[ "$diagram" != true ]] || TYPE_DIAGRAM+=" $name"
	done < <(yq 'to_entries | .[] | [.key, .value.required, .value.repeatable, .value.diagram] | join(" ")' "$TYPES_FILE")
}

all_types() { printf '%s\n' $TYPE_NAMES; }
optional_types() { printf '%s\n' $TYPE_OPTIONAL; }
repeatable_types() { printf '%s\n' $TYPE_REPEATABLE; }
required_types() { printf '%s\n' $TYPE_REQUIRED; }
# Print true or false: the flag $2 (repeatable or diagram) of the type $1.
type_flag() {
	local list=$TYPE_DIAGRAM
	[[ "$2" != repeatable ]] || list=$TYPE_REPEATABLE
	if one_of "$1" $list; then echo true; else echo false; fi
}

# Print the type of the artifact file name $1. Fail when the name is not
# <type>.md, or <type>-<name>.md of a repeatable type.
file_type() {
	local name=${1%.md} type suffix
	[[ "$1" == *.md ]] || return 1
	for type in $TYPE_NAMES; do
		[[ "$name" == "$type" ]] && echo "$type" && return 0
	done
	for type in $TYPE_NAMES; do
		[[ "$name" == "$type-"* ]] || continue
		suffix=${name#"$type-"}
		[[ "$suffix" =~ $SLUG_RE && $(type_flag "$type" repeatable) == true ]] && echo "$type" && return 0
	done
	return 1
}

# Print the front matter of the file $1 as JSON. Fail when it has none.
front_matter() {
	local first=""
	[[ -f "$1" ]] || return 1
	IFS= read -r first <"$1" || [[ -n "$first" ]] || return 1
	[[ "$first" == "---" ]] || return 1
	yq --front-matter=extract -o json '.' "$1" 2>/dev/null
}

# Print the field $2 of the front matter of the file $1, or nothing.
field() {
	front_matter "$1" | jq -r --arg key "$2" '.[$key] // empty | if type == "array" then .[] else . end' 2>/dev/null
}

# Print the field $2 of the front matter JSON $1, as field does.
json_field() {
	[[ -n "$1" ]] || return 0
	jq -r --arg key "$2" '.[$key] // empty | if type == "array" then .[] else . end' <<<"$1" 2>/dev/null
}

# Set front matter fields of the file $1 with the yq expression $2. The
# values come from environment variables, so no value is parsed as code.
set_fields() {
	yq -i --front-matter=process "$2" "$1"
}

touch_updated() {
	D=$(today) set_fields "$1" '.updated = strenv(D)'
}

# Print the file $1 without code blocks, HTML comments and inline code.
# Each line stays on its line number, so the text keeps its order.
prose() {
	awk -v fence="$FENCE" '
		index($0, fence) == 1 { code = !code; print ""; next }
		code { print ""; next }
		{
			line = $0; out = ""
			while (1) {
				if (comment) {
					i = index(line, "-->")
					if (!i) { line = ""; break }
					line = substr(line, i + 3); comment = 0
				}
				i = index(line, "<!--")
				if (!i) { out = out line; break }
				out = out substr(line, 1, i - 1); line = substr(line, i + 4); comment = 1
			}
			gsub(/`[^`]*`/, "", out)
			print out
		}' "$1"
}

# Print the source IDs that the file $1 cites, sorted by number. A
# footnote definition line is not a citation.
cited_ids() {
	prose "$1" | ids_of_prose
}

# Print the source IDs that the prose on stdin cites, sorted by number,
# each once. One awk, as a check runs it for every file.
ids_of_prose() {
	awk '
		/^\[\^S[0-9]+\]:/ { next }
		{
			line = $0
			while (match(line, /\[\^S[0-9]+\]/)) {
				digits = substr(line, RSTART + 3, RLENGTH - 4); n = digits + 0
				if (!(n in seen)) { seen[n] = digits; ids[++count] = n }
				line = substr(line, RSTART + RLENGTH)
			}
		}
		END {
			for (i = 2; i <= count; i++)
				for (j = i; j > 1 && ids[j - 1] > ids[j]; j--) { t = ids[j]; ids[j] = ids[j - 1]; ids[j - 1] = t }
			for (i = 1; i <= count; i++) print "S" seen[ids[i]]
		}'
}

# Print the register of the sources file $1 as lines "<id> TAB <key> TAB
# <value>". The heading of an entry gives the key "#". Each entry is a
# table with the rows "| <key> | <value> |". A "|" in a value is written
# as "\|". A table, not a "key: value" list, keeps Vale quiet about the
# capital letter after a colon.
register() {
	awk -v fence="$FENCE" '
		index($0, fence) == 1 { code = !code; next }
		code { next }
		/^## / { inside = ($0 == "## Register"); id = ""; next }
		!inside { next }
		/^### / { id = substr($0, 5); printf "%s\t#\t\n", id; next }
		id != "" && /^\| [a-z]+ \| .* \|$/ {
			key = substr($0, 3); sub(/ .*/, "", key)
			value = substr($0, length(key) + 6); sub(/ \|$/, "", value)
			gsub(/\\\|/, "|", value)
			printf "%s\t%s\t%s\n", id, key, value
		}' "$1"
}

# Print one row of a register table.
register_row() {
	printf '| %s | %s |\n' "$1" "$(sed 's/|/\\|/g' <<<"$2")"
}

# Keep the register of the sources file $1 in REG_ROWS, so that a check
# parses it once. The actions do not use it, as they change the file.
REG_FILE="" REG_ROWS=""
load_register() {
	REG_FILE=$1
	REG_ROWS=$(register "$1")
}

# Print the value of the key $3 of the source $2 in the sources file $1.
source_field() {
	if [[ "$1" != "$REG_FILE" ]]; then
		register "$1" | awk -F '\t' -v id="$2" -v key="$3" '$1 == id && $2 == key { print $3; exit }'
		return
	fi
	local row
	while IFS= read -r row; do
		if [[ "$row" == "$2"$'\t'"$3"$'\t'* ]]; then
			printf '%s\n' "${row#"$2"$'\t'"$3"$'\t'}"
			return
		fi
	done <<<"$REG_ROWS"
}

# Print the keys of the source $1 in REG_ROWS, without the heading key "#".
source_keys() {
	local row rest
	while IFS= read -r row; do
		[[ "$row" == "$1"$'\t'* ]] || continue
		rest=${row#"$1"$'\t'}
		[[ "${rest%%$'\t'*}" == "#" ]] || printf '%s\n' "${rest%%$'\t'*}"
	done <<<"$REG_ROWS"
}

# Print the ID of the first source in REG_ROWS with the url $1.
url_owner() {
	local row
	while IFS= read -r row; do
		if [[ "$row" == *$'\t'url$'\t'"$1" && "${row%%$'\t'*}"$'\t'url$'\t'"$1" == "$row" ]]; then
			printf '%s\n' "${row%%$'\t'*}"
			return
		fi
	done <<<"$REG_ROWS"
}

# Succeed when the sources file $1 has the source $2.
has_source() {
	if [[ "$1" != "$REG_FILE" ]]; then
		[[ -n "$(register "$1" | awk -F '\t' -v id="$2" '$1 == id && $2 == "#"')" ]]
		return
	fi
	[[ $'\n'"$REG_ROWS"$'\n' == *$'\n'"$2"$'\t#\t\n'* ]]
}

# Write the file $1 with fresh footnote definitions to the file $3. The
# definitions come from the sources file $2. Fail and print each unknown ID
# when the file cites a source that the register does not hold.
render_citations() {
	local file=$1 reg=$2 out=$3 id defs="" unknown=""
	for id in $(if [[ "$file" == "${PROSE_FILE:-}" ]]; then ids_of_prose <<<"$PROSE"; else cited_ids "$file"; fi); do
		if ! has_source "$reg" "$id"; then
			unknown+=" $id"
			continue
		fi
		defs+="[^$id]: [$id](sources.md#s${id#S}) $(source_field "$reg" "$id" author), $(source_field "$reg" "$id" title)."$'\n'
	done
	if [[ -n "$unknown" ]]; then
		echo "$unknown"
		return 1
	fi
	awk -v fence="$FENCE" '
		index($0, fence) == 1 { code = !code }
		!code && /^\[\^S[0-9]+\]: / { next }
		{ lines[++n] = $0; if ($0 !~ /^[[:space:]]*$/) last = n }
		END { for (i = 1; i <= last; i++) print lines[i] }' "$file" >"$out"
	[[ -z "$defs" ]] || printf '\n%s' "$defs" >>"$out"
}

# ---------------------------------------------------------------- check

PROBLEMS=0

problem() {
	echo "$1: $2"
	PROBLEMS=1
}

# Print the line numbers of Mermaid blocks with no prose paragraph right
# after them, then the line "count <n>" with the number of Mermaid blocks.
mermaid_scan() {
	awk -v fence="$FENCE" '
		code {
			if ($0 ~ /^```[[:space:]]*$/) { code = 0; if (mermaid) { want = 1; at = start }; mermaid = 0 }
			next
		}
		index($0, fence) == 1 {
			if (want) { print at; want = 0 }
			code = 1; mermaid = ($0 ~ /^```mermaid[[:space:]]*$/)
			if (mermaid) { count++; start = NR }
			next
		}
		want {
			if ($0 ~ /^[[:space:]]*$/) next
			if ($0 ~ /^(#|\||<!--|\[\^S[0-9]+\]:)/) print at
			want = 0
		}
		END { if (want) print at; print "count " count + 0 }' "$1"
}

# Print each list item of the "## Key findings" section of the file $1 on
# one line.
findings() {
	printf '%s\n' "$PROSE" | awk '
		/^## / { if (item != "") print item; item = ""; inside = ($0 == "## Key findings"); next }
		!inside { next }
		/^([-*]|[0-9]+\.) / { if (item != "") print item; item = $0; next }
		/^[[:space:]]*$/ { if (item != "") print item; item = ""; next }
		{ if (item != "") item = item " " $0 }
		END { if (item != "") print item }'
}

check_register() {
	local file=$1 rows ids id key value url first
	[[ "$REG_FILE" == "$file" ]] || load_register "$file"
	rows=$REG_ROWS
	ids=$(awk -F '\t' '$2 == "#" { print $1 }' <<<"$rows")
	[[ -n "$(awk -F '\t' '$2 == "#"' <<<"$rows" | cut -f 1 | sort | uniq -d)" ]] &&
		problem "$file" "the register has a source ID twice. Give each '### S<n>' heading its own number."
	while IFS= read -r id; do
		[[ -n "$id" ]] || continue
		[[ "$id" =~ ^S[1-9][0-9]*$ ]] || problem "$file" "source heading '### $id' must have the form '### S<n>', such as '### S1'. Rename it, and keep the ID that other files cite."
		for key in $(source_keys "$id"); do
			one_of "$key" $SOURCE_KEYS || problem "$file" "$id: unknown field '$key'. Remove the row. Allowed fields: $SOURCE_KEYS."
		done
		for key in kind author title url published accessed evidence; do
			[[ -n "$(source_field "$file" "$id" "$key")" ]] || problem "$file" "$id: the field '$key' is missing. Add the row '| $key | <value> |' to the table of $id."
		done
		value=$(source_field "$file" "$id" kind)
		[[ -z "$value" ]] || one_of "$value" $KINDS || problem "$file" "$id: kind '$value' is not allowed. Set kind to one of: $KINDS."
		url=$(source_field "$file" "$id" url)
		[[ -z "$url" || "$url" =~ $URL_RE ]] || problem "$file" "$id: url '$url' is not a full web address. Write it with http:// or https://."
		value=$(source_field "$file" "$id" archive)
		[[ -z "$value" || "$value" =~ $URL_RE ]] || problem "$file" "$id: archive '$value' is not a full web address. Write it with http:// or https://, or remove the row."
		value=$(source_field "$file" "$id" accessed)
		[[ -z "$value" || "$value" =~ $DATE_RE ]] || problem "$file" "$id: accessed '$value' is not a date. Write it as YYYY-MM-DD."
		value=$(source_field "$file" "$id" published)
		[[ -z "$value" || "$value" == unknown || "$value" =~ $DATE_RE ]] ||
			problem "$file" "$id: published '$value' is not a date. Write it as YYYY-MM-DD, or as unknown."
		if [[ -n "$url" ]]; then
			first=$(url_owner "$url")
			[[ "$first" == "$id" ]] ||
				problem "$file" "$id: the url is the same as the url of $first. Remove $id, and cite $first instead."
		fi
	done <<<"$ids"
	[[ -z "$(ids_of_prose <<<"$PROSE")" ]] || problem "$file" "the register must not cite sources. Remove each [^S<n>] reference from sources.md."
}

check_findings() {
	local file=$1 reg=$2 item id kind ok count=0
	while IFS= read -r item; do
		count=$((count + 1))
		[[ "$item" == *"(unverified)"* ]] && continue
		ok=0
		# An ID that is not in the register is reported as an unknown
		# citation, so it does not count as a second problem here.
		for id in $(grep -oE '\[\^S[0-9]+\]' <<<"$item" | sed -E 's/^\[\^//; s/\]$//'); do
			kind=$(source_field "$reg" "$id" kind)
			[[ -z "$kind" || "$kind" == primary ]] && ok=1
		done
		((ok)) || problem "$file" "key finding $count cites no source of kind primary. Cite a primary source, or end the item with (unverified)."
	done < <(findings "$file")
	((count > 0)) || problem "$file" "'## Key findings' has no list item. Write each finding as a '- ' item with a citation."
}

# Print the first line of $PROSE that starts with "# ".
first_heading() {
	local line
	while IFS= read -r line; do
		if [[ "$line" == "# "* ]]; then
			printf '%s\n' "$line"
			return
		fi
	done <<<"$PROSE"
}

# Check one artifact file $1 of the research folder $2 with the slug $3.
check_file() {
	local file=$1 dir=$2 slug=$3 name type json status value heading by scan line allowed created first=""
	local FM_OBJECT FM_TYPE FM_STATUS FM_KEYS FM_TITLE FM_CREATED FM_UPDATED FM_AUTHORS FM_BY FM_DEPTH FM_ARTIFACTS
	name=${file##*/}
	if ! type=$(file_type "$name"); then
		problem "$file" "the file name is not an artifact name. Rename it to <type>.md, or to <type>-<name>.md for a repeatable type ($(repeatable_types | paste -sd ' ' -)). Types: $(all_types | paste -sd ' ' -)."
		return
	fi
	IFS= read -r first <"$file"
	if [[ "$first" != "---" ]]; then
		problem "$file" "no YAML front matter. The file must start with a line '---'."
		return
	fi
	FM_OBJECT=false
	# One jq call reads every field. A value that is not a string reads as
	# its JSON text.
	json=$(front_matter "$file") && eval "$(jq -r '
		def raw: if type == "string" then . else tojson end;
		if type != "object" then @sh "FM_OBJECT=false" else
		@sh "FM_OBJECT=true",
		@sh "FM_TYPE=\(.type // "" | raw)",
		@sh "FM_STATUS=\(.status // "" | raw)",
		@sh "FM_KEYS=\(keys | join(" "))",
		@sh "FM_TITLE=\((.title // "" | strings) // "")",
		@sh "FM_CREATED=\(.created // "" | raw)",
		@sh "FM_UPDATED=\(.updated // "" | raw)",
		@sh "FM_AUTHORS=\((.authors | type) == "array" and (.authors | length) > 0 and all(.authors[]; type == "string" and length > 0))",
		@sh "FM_BY=\(.superseded_by // "" | raw)",
		@sh "FM_DEPTH=\(.depth // "" | raw)",
		@sh "FM_ARTIFACTS=\(.artifacts // [] | if type == "array" or type == "object" then [.[] | raw] | join(" ") else "" end)"
		end
	' <<<"$json" 2>/dev/null)"
	if [[ "$FM_OBJECT" != true ]]; then
		value=$(yq --front-matter=extract '.' "$file" 2>&1 >/dev/null | head -n 1 | sed -E 's/.*: //')
		problem "$file" "the front matter is not valid YAML: ${value:-it is not a list of keys and values}. Look for an unclosed quote or bracket, or a line without 'key: value', between the two '---' lines. To see the position, run: yq --front-matter=extract . $file"
		return
	fi
	PROSE=$(prose "$file")
	PROSE_FILE=$file
	[[ "$name" != report.md ]] || REPORT_STATUS=$FM_STATUS
	value=$FM_TYPE
	[[ "$value" == "$type" ]] || problem "$file" "front matter type is '$value', but the file name gives '$type'. Set 'type: $type', or rename the file."
	status=$FM_STATUS
	allowed=$FRONT_KEYS
	[[ "$type" == brief ]] && allowed+=" $BRIEF_KEYS"
	[[ "$status" == superseded ]] && allowed+=" $SUPERSEDED_KEYS"
	for value in $FM_KEYS; do
		one_of "$value" $allowed || problem "$file" "front matter key '$value' is not allowed here. Remove it. Allowed keys: $allowed."
	done
	value=$FM_TITLE
	if [[ -z "$value" ]]; then
		problem "$file" "front matter has no title. Add 'title: <text>', and make '# <text>' the first heading."
	elif [[ "$(first_heading)" != "# $value" ]]; then
		problem "$file" "the first heading must be '# $value', the title in the front matter. Change the heading or the title so that they match."
	fi
	one_of "$status" $STATUSES || problem "$file" "status '$status' is not allowed. Statuses: $STATUSES. Move the status only with: research.sh status $slug $name <status>"
	[[ "$FM_CREATED" =~ $DATE_RE ]] || problem "$file" "created '$FM_CREATED' is not a date. Write it as YYYY-MM-DD."
	[[ "$FM_UPDATED" =~ $DATE_RE ]] || problem "$file" "updated '$FM_UPDATED' is not a date. Write it as YYYY-MM-DD."
	created=$FM_CREATED
	value=$FM_UPDATED
	[[ "$created" =~ $DATE_RE && "$value" =~ $DATE_RE && "$value" < "$created" ]] &&
		problem "$file" "updated $value is earlier than created $created. Set updated to a date on or after $created."
	[[ "$FM_AUTHORS" == true ]] || problem "$file" "front matter needs authors as a list of one or more names, such as 'authors: [aade maintainers]'."
	if [[ "$status" == superseded ]]; then
		by=$FM_BY
		if [[ -z "$by" ]]; then
			problem "$file" "the status is superseded, but superseded_by is missing. Add the line 'superseded_by: <slug>' to the front matter, with the slug of the research that replaces this file: $(other_slugs "$slug")."
		elif [[ ! "$by" =~ $SLUG_PATH_RE || ! -d "$CHECK_ROOT/$by" ]]; then
			problem "$file" "superseded_by '$by' is not a research folder. Set it to the slug of the research that replaces this file: $(other_slugs "$slug")."
		fi
	fi
	if [[ "$type" == brief ]]; then
		value=$FM_DEPTH
		one_of "$value" $DEPTHS || problem "$file" "depth '$value' is not allowed. Set depth to one of: $DEPTHS."
		for value in $FM_ARTIFACTS; do
			one_of "$value" $TYPE_OPTIONAL ||
				problem "$file" "artifacts lists '$value', which is not an optional type. Remove it. Optional types: $(optional_types | paste -sd ' ' -)."
		done
	elif ! one_of "$type" $TYPE_REQUIRED; then
		one_of "$type" $BRIEF_ARTIFACTS ||
			problem "$file" "brief.md does not list '$type' in artifacts. Add it while the brief is a draft, ask the user to change an approved brief, or delete this file."
	fi

	while IFS= read -r heading; do
		[[ $'\n'"$PROSE"$'\n' == *$'\n'"$heading"$'\n'* ]] || problem "$file" "the heading '$heading' of the $type template is missing. Add it with this exact text, outside code blocks and comments."
	done < <(grep -E '^#{2,3} ' "$TEMPLATES/$type.md")

	scan=$(mermaid_scan "$file")
	for line in ${scan%count *}; do
		problem "$file" "the Mermaid diagram at line $line has no prose paragraph right after it. Add a paragraph that explains the diagram after its closing fence."
	done

	if one_of "$status" $COMPLETE; then
		line=$(awk '/<!-- fill:/ { print NR; exit }' "$file")
		[[ -z "$line" ]] || problem "$file" "a '<!-- fill: -->' placeholder is left at line $line, but the status is $status. Replace it with content, or move the file back to draft."
		[[ $(type_flag "$type" diagram) == true && "$scan" == *"count 0" ]] &&
			problem "$file" "a $type in status $status needs at least one Mermaid diagram. Add a mermaid code block, and a paragraph after it."
		# A superseded file was approved under an earlier final brief. reopen
		# keeps it, so it needs no final brief now.
		value=$BRIEF_STATUS
		[[ "$type" == brief || "$status" == superseded || "$value" == final ]] ||
			problem "$file" "the status is $status, but brief.md is ${value:-missing}. Get the approval of the user and run: research.sh status $slug brief.md final"
		[[ "$type" == report && -f "$dir/sources.md" ]] && check_findings "$file" "$dir/sources.md"
	fi

	if [[ "$type" == sources ]]; then
		check_register "$file"
	elif [[ -f "$dir/sources.md" ]]; then
		if ! value=$(render_citations "$file" "$dir/sources.md" "$CHECK_TMP"); then
			problem "$file" "cites$value, which sources.md does not have. Add each source with: research.sh source add $slug, or fix the ID."
		elif ! cmp -s "$CHECK_TMP" "$file"; then
			problem "$file" "the footnote definitions at the end of the file do not match sources.md. Do not edit them by hand. Run: research.sh cite sync $slug"
		fi
	fi
}

# Print the slugs of every research and sub-slug in CHECK_ROOT except the
# slug $1, or "none".
other_slugs() {
	local dir slug slugs
	slugs=$(for dir in "$CHECK_ROOT"/*/ "$CHECK_ROOT"/*/*/; do
		[[ -d "$dir" ]] || continue
		slug=${dir#"$CHECK_ROOT"/}
		slug=${slug%/}
		[[ "$slug" == "$1" ]] || echo "$slug"
	done | LC_ALL=C sort | paste -sd ' ' -)
	echo "$slugs" | sed 's/^$/none/; s/ /, /g'
}

# Print the slug of the research folder $1: its path below RESEARCH_ROOT,
# or its folder name when it lies outside.
slug_of() {
	local root dir
	if root=$(cd "$ROOT_DIR" 2>/dev/null && pwd -P) && dir=$(cd "$1" && pwd -P) && [[ "$dir" == "$root"/* ]]; then
		echo "${dir#"$root"/}"
	else
		basename "$1"
	fi
}

# Succeed when the report $1 links the child research $2 by its report,
# such as [Title](<sub-slug>/report.md), outside code and comments.
links_child() {
	prose "$1" | grep -qE "\]\((\./)?$2/report\.md(#[^)]*)?\)"
}

DEEP_HINT="the folder is nested deeper than <slug>/<sub-slug>. Sub-slugs go one level deep only. Move it up to a child research of its own, or delete it."

# Check the research folder $1 with the slug $2. A slug without "/" is a
# parent, and each of its subfolders is a child research. A child has no
# subfolder, so sub-slugs stay one level deep. CHECK_ROOT is the research
# root, where superseded_by finds the slug of another research.
check_research() {
	local dir=${1%/} slug=$2 name type file child sub
	local BRIEF_STATUS BRIEF_ARTIFACTS REPORT_STATUS="" json
	name=${dir##*/}
	if [[ "$slug" == */*/* ]]; then
		problem "$dir" "$DEEP_HINT"
		return
	fi
	CHECK_ROOT=$(dirname "$dir")
	[[ "$slug" == */* ]] && CHECK_ROOT=$(dirname "$CHECK_ROOT")
	BRIEF_STATUS="" BRIEF_ARTIFACTS=""
	if [[ -f "$dir/brief.md" ]]; then
		json=$(front_matter "$dir/brief.md")
		BRIEF_STATUS=$(json_field "$json" status)
		BRIEF_ARTIFACTS=$(json_field "$json" artifacts)
	fi
	REG_FILE="" REG_ROWS=""
	[[ ! -f "$dir/sources.md" ]] || load_register "$dir/sources.md"
	[[ "$name" =~ $SLUG_RE ]] || problem "$dir" "the slug '$name' is not kebab-case. Rename the folder to lower-case letters, digits and hyphens, such as '$(tr '[:upper:]_ ' '[:lower:]--' <<<"$name")'."
	for type in $TYPE_REQUIRED; do
		[[ -f "$dir/$type.md" ]] || problem "$dir" "the required file $type.md is missing. Run: research.sh add $slug $type --title <t> --author <a>"
	done
	for file in "$dir"/*.md; do
		[[ -f "$file" ]] && check_file "$file" "$dir" "$slug"
	done
	# BRIEF_*, REPORT_STATUS and the register are set for each research.
	# The first two are local, so a child does not change them here.
	for child in "$dir"/*/; do
		[[ -d "$child" ]] || continue
		child=${child%/}
		sub=$(basename "$child")
		if [[ "$slug" == */* ]]; then
			problem "$child" "$DEEP_HINT"
			continue
		fi
		# From review on, the report claims an answer, so it must lead the
		# reader to each child research.
		one_of "$REPORT_STATUS" $COMPLETE && ! links_child "$dir/report.md" "$sub" &&
			problem "$dir/report.md" "the report does not link the sub-slug research '$sub'. Add a link to $sub/report.md, such as [<title>]($sub/report.md)."
		check_research "$child" "$slug/$sub"
		CHECK_ROOT=$(dirname "$dir")
	done
	# A draft research may still lack some files. From review on, the
	# report claims an answer, so every requested artifact must exist.
	[[ -f "$dir/brief.md" ]] && one_of "$REPORT_STATUS" $COMPLETE || return 0
	for type in $BRIEF_ARTIFACTS; do
		compgen -G "$dir/$type.md" >/dev/null || compgen -G "$dir/$type-*.md" >/dev/null ||
			problem "$dir" "brief.md lists '$type' in artifacts, but the folder has no $type file. Run: research.sh add $slug $type --title <t> --author <a>, or remove '$type' from artifacts while the brief is a draft."
	done
}

cmd_check() {
	local arg dir
	# One scratch file for the footnote check of every file.
	CHECK_TMP=$(mktemp) || die "mktemp failed." 2
	trap 'rm -f "$CHECK_TMP"' EXIT
	if (($# == 0)); then
		for dir in "$ROOT_DIR"/*/; do
			[[ -d "$dir" ]] && check_research "$dir" "$(basename "$dir")"
		done
	else
		for arg in "$@"; do
			dir=$arg
			[[ -d "$dir" ]] || dir="$ROOT_DIR/$arg"
			[[ -d "$dir" ]] || die "No research folder $arg." 2
			check_research "$dir" "$(slug_of "$dir")"
		done
	fi
	return $PROBLEMS
}

# ----------------------------------------------------------- the actions

# Fail unless $1 is one line of text that is not empty. $2 names it.
need_line() {
	[[ -n "$1" ]] || die "$2 must not be empty." 2
	[[ "$1" != *$'\n'* && "$1" != *$'\t'* ]] || die "$2 must be one line without tabs." 2
}

research_dir() {
	[[ "$1" =~ $SLUG_PATH_RE ]] || die "The slug '$1' must be kebab-case. Use <slug> or <slug>/<sub-slug>." 2
	echo "$ROOT_DIR/$1"
}

# Create the file $1 of the type $2 from its template. TITLE and AUTHORS
# (a JSON list) come from the environment.
new_artifact() {
	cp "$TEMPLATES/$2.md" "$1"
	D=$(today) set_fields "$1" '.title = strenv(TITLE) | .created = strenv(D) | .updated = strenv(D) | .authors = env(AUTHORS) | .authors style="" | .authors[] style=""'
	awk '!done && $0 == "# Title" { print "# " ENVIRON["TITLE"]; done = 1; next } 1' "$1" >"$1.tmp" && mv "$1.tmp" "$1"
	echo "$1"
}

# Parse --title and --author. Sets TITLE and AUTHORS, and REST to the
# other arguments.
parse_common() {
	TITLE="" AUTHORS="[]" REST=()
	while (($#)); do
		case $1 in
		--title) TITLE=${2-}; shift 2 || usage ;;
		--author)
			need_line "${2-}" "--author"
			AUTHORS=$(jq -c --arg a "$2" '. + [$a]' <<<"$AUTHORS")
			shift 2
			;;
		*) REST+=("$1"); shift ;;
		esac
	done
	need_line "$TITLE" "--title"
	[[ "$AUTHORS" != "[]" ]] || die "Give at least one --author." 2
	export TITLE AUTHORS
}

# Print the "### $1" section of the issue body in ISSUE_BODY, without the
# blank lines around it. Print nothing for a field without a response.
issue_section() {
	WANT="### $1" awk '
		{ sub(/\r$/, "") }
		/^### / { inside = ($0 == ENVIRON["WANT"]); next }
		!inside { next }
		/^[ \t]*$/ { if (n) blank++; next }
		{ while (blank) { out = out "\n"; blank-- } out = out (n++ ? "\n" : "") $0 }
		END { if (out != "_No response_") printf "%s", out }
	' <<<"$ISSUE_BODY"
}

# Replace the first fill comment under the heading $2 of the file $1 with
# the text in FILL.
fill_section() {
	H=$2 awk '
		$0 == ENVIRON["H"] { inside = 1; print; next }
		inside && /^#/ { inside = 0 }
		inside && /^<!-- fill:/ { print ENVIRON["FILL"]; inside = 0; next }
		{ print }
	' "$1" >"$1.tmp" && mv "$1.tmp" "$1"
}

# Read the issue $1 for init --issue, and refuse one that is not a
# research request. Sets ISSUE_TITLE, ISSUE_URL, ISSUE_BODY, and the depth,
# artifacts and slug of the issue in ISSUE_DEPTH_VALUE, ISSUE_ARTIFACT_LIST
# and ISSUE_SLUG_VALUE.
read_issue() {
	local json artifact
	json=$(gh issue view "$1" --json title,body,labels,url) || die "gh could not read issue #$1."
	jq -e --arg l "$ISSUE_LABEL" 'any(.labels[]; .name == $l)' <<<"$json" >/dev/null ||
		die "Issue #$1 has no $ISSUE_LABEL label. Open a research request with: mise run issue:new research"
	ISSUE_TITLE=$(jq -r '.title' <<<"$json")
	ISSUE_URL=$(jq -r '.url' <<<"$json")
	ISSUE_BODY=$(jq -r '.body // ""' <<<"$json")
	ISSUE_DEPTH_VALUE=$(issue_section "$ISSUE_DEPTH")
	one_of "$ISSUE_DEPTH_VALUE" $DEPTHS || die "Issue #$1: the $ISSUE_DEPTH section must be one of: $DEPTHS."
	ISSUE_ARTIFACT_LIST=$(issue_section "$ISSUE_ARTIFACTS" | sed -nE 's/^- \[[xX]\] (.+)$/\1/p')
	for artifact in $ISSUE_ARTIFACT_LIST; do
		one_of "$artifact" $(optional_types) ||
			die "Issue #$1: the artifact $artifact is not one of: $(optional_types | paste -sd ' ' -)."
	done
	ISSUE_SLUG_VALUE=$(issue_section "$ISSUE_SLUG")
}

cmd_init() {
	local slug=${1-} dir depth=standard artifacts="[]" type parent="" status issue="" title_given=false
	local args=() artifact label heading text own_type=""
	[[ -n "$slug" ]] || usage
	shift
	# --issue first, because the title of the issue is the default --title.
	while (($#)); do
		case $1 in
		--issue)
			[[ $# -ge 2 ]] || usage
			[[ "$2" =~ ^[1-9][0-9]*$ ]] || die "--issue must be an issue number." 2
			issue=$2; shift 2
			;;
		--title) title_given=true; args+=("$1" "${2-}"); shift 2 || usage ;;
		--depth | --artifact) own_type=$1; args+=("$1" "${2-}"); shift 2 || usage ;;
		*) args+=("$1"); shift ;;
		esac
	done
	if [[ -n "$issue" ]]; then
		[[ -z "$own_type" ]] || die "$own_type comes from the issue, so init --issue takes no $own_type." 2
		read_issue "$issue"
		$title_given || args+=(--title "$ISSUE_TITLE")
		[[ -z "$ISSUE_SLUG_VALUE" || "$ISSUE_SLUG_VALUE" == "$slug" ]] ||
			die "Issue #$issue names the slug $ISSUE_SLUG_VALUE, not $slug."
		depth=$ISSUE_DEPTH_VALUE
		for artifact in $ISSUE_ARTIFACT_LIST; do
			args+=(--artifact "$artifact")
		done
	fi
	parse_common ${args[@]+"${args[@]}"}
	set -- ${REST[@]+"${REST[@]}"}
	while (($#)); do
		case $1 in
		--depth) depth=${2-}; shift 2 || usage ;;
		--artifact)
			one_of "${2-}" $(optional_types) || die "--artifact must be one of: $(optional_types | paste -sd ' ' -)." 2
			artifacts=$(jq -c --arg a "$2" 'if index($a) then . else . + [$a] end' <<<"$artifacts")
			shift 2
			;;
		*) usage ;;
		esac
	done
	one_of "$depth" $DEPTHS || die "--depth must be one of: $DEPTHS." 2
	dir=$(research_dir "$slug") || exit 2
	[[ ! -e "$dir" ]] || die "$dir exists already. To continue that research, run research.sh progress $slug first."
	# A child research needs its parent. init never changes the parent.
	if [[ "$slug" == */* ]]; then
		parent=${slug%/*}
		[[ -d "$ROOT_DIR/$parent" ]] || die "No research $parent. Run research.sh init $parent first, or pick another parent."
	fi
	mkdir -p "$dir"
	for type in $(required_types); do
		new_artifact "$dir/$type.md" "$type"
	done
	DEPTH=$depth ARTIFACTS=$artifacts set_fields "$dir/brief.md" \
		'.depth = strenv(DEPTH) | .artifacts = env(ARTIFACTS) | .artifacts style="" | .artifacts[] style=""'
	if [[ -n "$issue" ]]; then
		while IFS='=' read -r label heading; do
			text=$(issue_section "$label")
			[[ "$heading" != "## Background" ]] || text="${text:+$text$'\n\n'}Requested in issue [#$issue]($ISSUE_URL)."
			[[ -z "$text" ]] || FILL=$text fill_section "$dir/brief.md" "$heading"
		done < <(tr ';' '\n' <<<"$ISSUE_SECTIONS")
	fi
	[[ -n "$parent" ]] || return 0
	status=$(field "$ROOT_DIR/$parent/report.md" status)
	one_of "$status" $COMPLETE || return 0
	>&2 echo "The report of $parent is $status, so the check now wants a link to ${slug#*/}/report.md in it. Move the report back to draft first: research.sh reopen $parent for a final brief, or research.sh status $parent report.md draft from review."
}

cmd_add() {
	local slug=${1-} type=${2-} name="" dir file brief
	[[ -n "$slug" && -n "$type" ]] || usage
	shift 2
	parse_common "$@"
	set -- ${REST[@]+"${REST[@]}"}
	while (($#)); do
		case $1 in
		--name) name=${2-}; shift 2 || usage ;;
		*) usage ;;
		esac
	done
	dir=$(research_dir "$slug") || exit 2
	brief="$dir/brief.md"
	[[ -d "$dir" ]] || die "No research $slug. Run research.sh init first."
	one_of "$type" $(all_types) || die "The type must be one of: $(all_types | paste -sd ' ' -)." 2
	file="$dir/$type.md"
	if [[ -n "$name" ]]; then
		[[ "$name" =~ $SLUG_RE ]] || die "--name must be kebab-case." 2
		[[ $(type_flag "$type" repeatable) == true ]] || die "A $type is not repeatable, so it takes no --name." 2
		file="$dir/$type-$name.md"
	fi
	[[ ! -e "$file" ]] || die "$file exists already."
	# init creates the required types. add creates one again only when its
	# file is missing, such as after a deleted sources.md.
	if one_of "$type" $(required_types); then
		:
	elif [[ ! -f "$brief" ]]; then
		die "$brief is missing. Run: research.sh add $slug brief --title <t> --author <a>"
	elif ! one_of "$type" $(field "$brief" artifacts); then
		[[ "$(field "$brief" status)" == draft ]] ||
			die "The brief does not request the type $type, and it is past draft. Ask the user to change the brief."
		TYPE=$type set_fields "$brief" '.artifacts += [strenv(TYPE)] | .artifacts style="" | .artifacts[] style=""'
		touch_updated "$brief"
	fi
	new_artifact "$file" "$type"
}

cmd_source() {
	[[ "${1-}" == add && -n "${2-}" ]] || usage
	local slug=$2 dir reg kind="" author="" title="" url="" evidence="" published=unknown archive="" id last
	shift 2
	while (($#)); do
		case $1 in
		--kind) kind=${2-} ;;
		--author) author=${2-} ;;
		--title) title=${2-} ;;
		--url) url=${2-} ;;
		--evidence) evidence=${2-} ;;
		--published) published=${2-} ;;
		--archive) archive=${2-} ;;
		*) usage ;;
		esac
		shift 2 || usage
	done
	one_of "$kind" $KINDS || die "--kind must be one of: $KINDS." 2
	need_line "$author" "--author"
	need_line "$title" "--title"
	need_line "$evidence" "--evidence"
	[[ "$url" =~ $URL_RE ]] || die "--url must start with http:// or https://." 2
	[[ -z "$archive" || "$archive" =~ $URL_RE ]] || die "--archive must start with http:// or https://." 2
	[[ "$published" == unknown || "$published" =~ $DATE_RE ]] || die "--published must be YYYY-MM-DD." 2
	dir=$(research_dir "$slug") || exit 2
	reg="$dir/sources.md"
	[[ -f "$reg" ]] || die "No $reg. Run research.sh init first."
	id=$(register "$reg" | awk -F '\t' -v url="$url" '$2 == "url" && $3 == url { print $1; exit }')
	if [[ -n "$id" ]]; then
		>&2 echo "The register holds this url already as $id."
		echo "$id"
		return 0
	fi
	last=$(register "$reg" | awk -F '\t' '$2 == "#" && $1 ~ /^S[0-9]+$/ { n = substr($1, 2) + 0; if (n > max) max = n } END { print max + 0 }')
	id="S$((last + 1))"
	[[ -z "$(tail -c 1 "$reg")" ]] || echo >>"$reg"
	{
		printf '\n### %s\n\n| Field | Value |\n| --- | --- |\n' "$id"
		register_row kind "$kind"
		register_row author "$author"
		register_row title "$title"
		register_row url "$url"
		register_row published "$published"
		register_row accessed "$(today)"
		[[ -z "$archive" ]] || register_row archive "$archive"
		register_row evidence "$evidence"
	} >>"$reg"
	touch_updated "$reg"
	echo "$id"
}

cmd_cite() {
	[[ "${1-}" == sync && -n "${2-}" && $# -eq 2 ]] || usage
	local dir file tmp unknown status=0
	dir=$(research_dir "$2") || exit 2
	[[ -f "$dir/sources.md" ]] || die "No $dir/sources.md. Run research.sh init first."
	for file in "$dir"/*.md; do
		[[ "$(basename "$file")" == sources.md ]] && continue
		tmp=$(mktemp)
		if ! unknown=$(render_citations "$file" "$dir/sources.md" "$tmp"); then
			>&2 echo "$file: cites sources that are not in sources.md:$unknown."
			status=1
		elif ! cmp -s "$tmp" "$file"; then
			cat "$tmp" >"$file"
			touch_updated "$file"
			echo "$file"
		fi
		rm -f "$tmp"
	done
	return $status
}

cmd_status() {
	local slug=${1-} name=${2-} new=${3-} by="" dir file old backup report
	[[ -n "$slug" && -n "$name" && -n "$new" ]] || usage
	shift 3
	while (($#)); do
		case $1 in
		--by) by=${2-}; shift 2 || usage ;;
		*) usage ;;
		esac
	done
	dir=$(research_dir "$slug") || exit 2
	file="$dir/$name"
	[[ -f "$file" ]] || die "No $file."
	one_of "$new" $STATUSES || die "The status must be one of: $STATUSES." 2
	old=$(field "$file" status)
	case "$old>$new" in
	"draft>review" | "review>draft" | "review>final" | "final>superseded") ;;
	"final>draft") die "$name cannot move from final to draft. To continue an approved research, run: research.sh reopen $slug" ;;
	*) die "$name cannot move from $old to $new. Allowed: draft>review, review>draft, review>final, final>superseded." ;;
	esac
	if [[ "$new" == superseded ]]; then
		[[ -n "$by" && "$by" != "$slug" && "$by" =~ $SLUG_PATH_RE && -d "$ROOT_DIR/$by" ]] ||
			die "superseded needs --by with the slug of another research." 2
	elif [[ -n "$by" ]]; then
		die "--by applies only to superseded." 2
	fi
	backup=$(mktemp)
	cp "$file" "$backup"
	NEW=$new set_fields "$file" '.status = strenv(NEW)'
	[[ -z "$by" ]] || BY=$by set_fields "$file" '.superseded_by = strenv(BY)'
	touch_updated "$file"
	# Only the problems of this file, and of the folder, block the move. A
	# brief can be approved while the other artifacts are still drafts.
	if one_of "$new" review final; then
		report=$(cmd_check "$dir" | grep -F -e "$file: " -e "$dir: " || true)
	fi
	if [[ -n "${report-}" ]]; then
		cat "$backup" >"$file"
		rm -f "$backup"
		echo "$report"
		die "The status stays $old. Fix the problems above first."
	fi
	rm -f "$backup"
	echo "$file: $old > $new"
}

# Move an approved research back to draft, so that it can take new
# requirements: the final brief and every other file in review or final.
# Superseded files and the source IDs stay as they are. The children of a
# parent are research of their own, so they stay too.
cmd_reopen() {
	local slug=${1-} dir file old
	[[ -n "$slug" && $# -eq 1 ]] || usage
	dir=$(research_dir "$slug") || exit 2
	[[ -f "$dir/brief.md" ]] || die "No $dir/brief.md."
	old=$(field "$dir/brief.md" status)
	[[ "$old" == final ]] ||
		die "The brief of $slug is ${old:-without status}, not final. reopen applies only to an approved research. Move a file from review to draft with: research.sh status $slug <file> draft"
	for file in "$dir"/*.md; do
		[[ -f "$file" ]] || continue
		old=$(field "$file" status)
		one_of "$old" review final || continue
		NEW=draft set_fields "$file" '.status = strenv(NEW)'
		touch_updated "$file"
		echo "$file: $old > draft"
	done
}

# Print the progress of a research: the status of each file, the open
# placeholders, the number of sources and the sub-slugs.
cmd_progress() {
	local slug=${1-} dir file status lines child line
	[[ -n "$slug" && $# -eq 1 ]] || usage
	dir=$(research_dir "$slug") || exit 2
	[[ -d "$dir" ]] || die "No research $slug."
	echo "research: $slug"
	if [[ "$slug" == */* ]]; then
		status=$(field "$ROOT_DIR/${slug%/*}/report.md" status)
		echo "parent: ${slug%/*} (report: ${status:-missing})"
	else
		echo "parent: none"
	fi
	echo "files:"
	lines=""
	for file in "$dir"/*.md; do
		[[ -f "$file" ]] || continue
		status=$(field "$file" status)
		echo "  $(basename "$file"): ${status:-no status}"
		for line in $(grep -n '<!-- fill:' "$file" | cut -d : -f 1); do
			lines+="  $(basename "$file"):$line"$'\n'
		done
	done
	if [[ -n "$lines" ]]; then
		printf 'placeholders:\n%s' "$lines"
	else
		echo "placeholders: none"
	fi
	if [[ -f "$dir/sources.md" ]]; then
		echo "sources: $(register "$dir/sources.md" | awk -F '\t' '$2 == "#" { n++ } END { print n + 0 }')"
	else
		echo "sources: no sources.md"
	fi
	lines=""
	for child in "$dir"/*/; do
		[[ -d "$child" ]] || continue
		status=$(field "$child/report.md" status)
		lines+="  $(basename "$child") (report: ${status:-missing})"$'\n'
	done
	if [[ -n "$lines" ]]; then
		printf 'sub-slugs:\n%s' "$lines"
	else
		echo "sub-slugs: none"
	fi
}

command=${1-}
(($#)) && shift
# Stop on a bad RESEARCH_TODAY before an action that writes. A die inside
# "$(today)" ends only its subshell, so the action would write empty dates.
# check, progress and the usage write no date, so they ignore it.
case $command in
init | add | source | cite | status | reopen) today >/dev/null ;;
esac
case $command in
init | add | source | cite | status | check) load_types ;;
esac
case $command in
init) cmd_init "$@" ;;
add) cmd_add "$@" ;;
source) cmd_source "$@" ;;
cite) cmd_cite "$@" ;;
status) cmd_status "$@" ;;
check) cmd_check "$@" ;;
progress) cmd_progress "$@" ;;
reopen) cmd_reopen "$@" ;;
*) usage ;;
esac
