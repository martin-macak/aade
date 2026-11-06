#!/usr/bin/env bash

# The tech-research tool. It does every action on a research folder that
# must give the same result each time: it creates the folder and the typed
# artifacts from the templates, adds sources to the register, writes the
# footnote definitions, moves the status, and checks the folder. The
# tech-research skill explains the format.
#
# Usage:
#   research.sh init <slug> --title <t> --author <a>... [--depth <d>] [--artifact <type>]...
#   research.sh add <slug> <type> [--name <n>] --title <t> --author <a>...
#   research.sh source add <slug> --kind <k> --author <a> --title <t> --url <u>
#       --evidence <e> [--published <yyyy-mm-dd>] [--archive <url>]
#   research.sh cite sync <slug>
#   research.sh status <slug> <file> <status> [--by <slug>]
#   research.sh check [<slug>...]
#
# Run it from the repository root. RESEARCH_ROOT sets the research folder
# (default docs/research). RESEARCH_TODAY sets the date in YYYY-MM-DD form
# (default: the current date), so tests get fixed dates.
# It needs yq and jq, and runs on bash 3.2.
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
SLUG_RE='^[a-z0-9]+(-[a-z0-9]+)*$'
DATE_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
URL_RE='^https?://[^[:space:]]+$'
FENCE='```'

usage() {
	>&2 sed -n '/^# Usage:/,/^# Run it/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
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

all_types() { yq 'keys | .[]' "$TYPES_FILE"; }
optional_types() { yq 'to_entries | .[] | select(.value.required == false) | .key' "$TYPES_FILE"; }
required_types() { yq 'to_entries | .[] | select(.value.required == true) | .key' "$TYPES_FILE"; }
# Print true or false: the flag $2 of the type $1.
type_flag() { yq ".[\"$1\"].$2" "$TYPES_FILE"; }

# Print the type of the artifact file name $1. Fail when the name is not
# <type>.md, or <type>-<name>.md of a repeatable type.
file_type() {
	local name=${1%.md} type suffix
	[[ "$1" == *.md ]] || return 1
	for type in $(all_types); do
		[[ "$name" == "$type" ]] && echo "$type" && return 0
	done
	for type in $(all_types); do
		[[ "$name" == "$type-"* ]] || continue
		suffix=${name#"$type-"}
		[[ "$suffix" =~ $SLUG_RE && $(type_flag "$type" repeatable) == true ]] && echo "$type" && return 0
	done
	return 1
}

# Print the front matter of the file $1 as JSON. Fail when it has none.
front_matter() {
	[[ "$(head -n 1 "$1")" == "---" ]] || return 1
	yq --front-matter=extract -o json '.' "$1" 2>/dev/null
}

# Print the field $2 of the front matter of the file $1, or nothing.
field() {
	front_matter "$1" | jq -r --arg key "$2" '.[$key] // empty | if type == "array" then .[] else . end' 2>/dev/null
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
	prose "$1" | grep -vE '^\[\^S[0-9]+\]:' | grep -oE '\[\^S[0-9]+\]' |
		sed -E 's/^\[\^S//; s/\]$//' | sort -n -u | sed 's/^/S/'
	return 0
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

# Print the value of the key $3 of the source $2 in the sources file $1.
source_field() {
	register "$1" | awk -F '\t' -v id="$2" -v key="$3" '$1 == id && $2 == key { print $3; exit }'
}

# Write the file $1 with fresh footnote definitions to the file $3. The
# definitions come from the sources file $2. Fail and print each unknown ID
# when the file cites a source that the register does not hold.
render_citations() {
	local file=$1 reg=$2 out=$3 id defs="" unknown=""
	for id in $(cited_ids "$file"); do
		if [[ -z "$(register "$reg" | awk -F '\t' -v id="$id" '$1 == id && $2 == "#"')" ]]; then
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
	prose "$1" | awk '
		/^## / { if (item != "") print item; item = ""; inside = ($0 == "## Key findings"); next }
		!inside { next }
		/^([-*]|[0-9]+\.) / { if (item != "") print item; item = $0; next }
		/^[[:space:]]*$/ { if (item != "") print item; item = ""; next }
		{ if (item != "") item = item " " $0 }
		END { if (item != "") print item }'
}

check_register() {
	local file=$1 rows ids id key value seen_urls="" url
	rows=$(register "$file")
	ids=$(awk -F '\t' '$2 == "#" { print $1 }' <<<"$rows")
	[[ -n "$(awk -F '\t' '$2 == "#"' <<<"$rows" | cut -f 1 | sort | uniq -d)" ]] &&
		problem "$file" "the register holds a source ID twice."
	for id in $ids; do
		[[ "$id" =~ ^S[1-9][0-9]*$ ]] || problem "$file" "source heading '### $id' must be '### S<n>'."
		for key in $(awk -F '\t' -v id="$id" '$1 == id && $2 != "#" { print $2 }' <<<"$rows"); do
			one_of "$key" $SOURCE_KEYS || problem "$file" "$id: unknown key '$key'. Keys: $SOURCE_KEYS."
		done
		for key in kind author title url published accessed evidence; do
			[[ -n "$(source_field "$file" "$id" "$key")" ]] || problem "$file" "$id: missing '$key'."
		done
		value=$(source_field "$file" "$id" kind)
		[[ -z "$value" ]] || one_of "$value" $KINDS || problem "$file" "$id: kind '$value' must be one of: $KINDS."
		url=$(source_field "$file" "$id" url)
		[[ -z "$url" || "$url" =~ $URL_RE ]] || problem "$file" "$id: url must start with http:// or https://."
		value=$(source_field "$file" "$id" archive)
		[[ -z "$value" || "$value" =~ $URL_RE ]] || problem "$file" "$id: archive must start with http:// or https://."
		value=$(source_field "$file" "$id" accessed)
		[[ -z "$value" || "$value" =~ $DATE_RE ]] || problem "$file" "$id: accessed must be YYYY-MM-DD."
		value=$(source_field "$file" "$id" published)
		[[ -z "$value" || "$value" == unknown || "$value" =~ $DATE_RE ]] ||
			problem "$file" "$id: published must be YYYY-MM-DD or unknown."
		if [[ -n "$url" ]]; then
			one_of "$url" $seen_urls && problem "$file" "$id: the url is already in the register."
			seen_urls+=" $url"
		fi
	done
	[[ -z "$(cited_ids "$file")" ]] || problem "$file" "the register must not cite sources. Cite them in the other artifacts."
}

check_findings() {
	local file=$1 reg=$2 item id ok count=0
	while IFS= read -r item; do
		count=$((count + 1))
		[[ "$item" == *"(unverified)"* ]] && continue
		ok=0
		for id in $(grep -oE '\[\^S[0-9]+\]' <<<"$item" | sed -E 's/^\[\^//; s/\]$//'); do
			[[ "$(source_field "$reg" "$id" kind)" == primary ]] && ok=1
		done
		((ok)) || problem "$file" "key finding $count cites no primary source and is not marked (unverified)."
	done < <(findings "$file")
	((count > 0)) || problem "$file" "'## Key findings' holds no list item."
}

# Check one artifact file $1 of the research folder $2.
check_file() {
	local file=$1 dir=$2 name type json status value heading by scan line tmp
	name=$(basename "$file")
	if ! type=$(file_type "$name"); then
		problem "$file" "not an artifact name. Use <type>.md, or <type>-<name>.md for a repeatable type. Types: $(all_types | tr '\n' ' ')"
		return
	fi
	if ! json=$(front_matter "$file"); then
		problem "$file" "no YAML front matter."
		return
	fi
	value=$(jq -r '.type // ""' <<<"$json")
	[[ "$value" == "$type" ]] || problem "$file" "front matter type is '$value', but the file name gives '$type'."
	[[ -n "$(jq -r '.title // "" | strings' <<<"$json")" ]] || problem "$file" "front matter needs a title."
	status=$(jq -r '.status // ""' <<<"$json")
	one_of "$status" $STATUSES || problem "$file" "status '$status' must be one of: $STATUSES."
	for line in created updated; do
		value=$(jq -r --arg k "$line" '.[$k] // ""' <<<"$json")
		[[ "$value" =~ $DATE_RE ]] || problem "$file" "$line must be YYYY-MM-DD."
	done
	[[ "$(jq -r '.updated // ""' <<<"$json")" < "$(jq -r '.created // ""' <<<"$json")" ]] &&
		problem "$file" "updated is earlier than created."
	jq -e '(.authors | type) == "array" and (.authors | length) > 0 and all(.authors[]; type == "string" and length > 0)' \
		<<<"$json" >/dev/null || problem "$file" "front matter needs a list of authors."
	if [[ "$status" == superseded ]]; then
		by=$(jq -r '.superseded_by // ""' <<<"$json")
		[[ -n "$by" && -d "$(dirname "$dir")/$by" ]] ||
			problem "$file" "a superseded artifact needs superseded_by with the slug of an existing research."
	fi
	if [[ "$type" == brief ]]; then
		value=$(jq -r '.depth // ""' <<<"$json")
		one_of "$value" $DEPTHS || problem "$file" "depth '$value' must be one of: $DEPTHS."
		for value in $(jq -r '.artifacts // [] | .[]' <<<"$json"); do
			one_of "$value" $(optional_types) ||
				problem "$file" "artifacts lists '$value'. Use only these types: $(optional_types | tr '\n' ' ')"
		done
	elif ! one_of "$type" $(required_types); then
		one_of "$type" $(field "$dir/brief.md" artifacts) ||
			problem "$file" "the brief does not request the type '$type' in artifacts."
	fi

	while IFS= read -r heading; do
		prose "$file" | grep -qxF "$heading" || problem "$file" "missing the heading '$heading' of the template."
	done < <(grep -E '^#{2,3} ' "$TEMPLATES/$type.md")

	scan=$(mermaid_scan "$file")
	for line in $(grep -v '^count' <<<"$scan"); do
		problem "$file" "the Mermaid diagram at line $line needs a prose paragraph right after it."
	done

	if one_of "$status" review final; then
		grep -q '<!-- fill:' "$file" && problem "$file" "a '<!-- fill: -->' placeholder is left."
		[[ $(type_flag "$type" diagram) == true && "$scan" == *"count 0" ]] &&
			problem "$file" "a $type needs at least one Mermaid diagram."
		[[ "$type" == brief || "$(field "$dir/brief.md" status)" == final ]] ||
			problem "$file" "the status is $status, but the brief is not final yet."
		[[ "$type" == report && -f "$dir/sources.md" ]] && check_findings "$file" "$dir/sources.md"
	fi

	if [[ "$type" == sources ]]; then
		check_register "$file"
	elif [[ -f "$dir/sources.md" ]]; then
		tmp=$(mktemp)
		if ! value=$(render_citations "$file" "$dir/sources.md" "$tmp"); then
			problem "$file" "cites sources that are not in sources.md:$value."
		elif ! cmp -s "$tmp" "$file"; then
			problem "$file" "the footnote definitions are out of date. Run: research.sh cite sync $(basename "$dir")"
		fi
		rm -f "$tmp"
	fi
}

check_research() {
	local dir=${1%/} slug type file
	slug=$(basename "$dir")
	[[ "$slug" =~ $SLUG_RE ]] || problem "$dir" "the slug must be kebab-case: lower-case letters, digits and hyphens."
	for type in $(required_types); do
		[[ -f "$dir/$type.md" ]] || problem "$dir" "missing $type.md."
	done
	for file in "$dir"/*.md; do
		[[ -f "$file" ]] && check_file "$file" "$dir"
	done
	# A draft research may still lack some files. From review on, the
	# report claims an answer, so every requested artifact must exist.
	[[ -f "$dir/brief.md" ]] && one_of "$(field "$dir/report.md" status)" review final || return 0
	for type in $(field "$dir/brief.md" artifacts); do
		compgen -G "$dir/$type.md" >/dev/null || compgen -G "$dir/$type-*.md" >/dev/null ||
			problem "$dir" "the brief requests the type $type, but the folder has no file of it."
	done
}

cmd_check() {
	local arg dir
	if (($# == 0)); then
		for dir in "$ROOT_DIR"/*/; do
			[[ -d "$dir" ]] && check_research "$dir"
		done
	else
		for arg in "$@"; do
			dir=$arg
			[[ -d "$dir" ]] || dir="$ROOT_DIR/$arg"
			[[ -d "$dir" ]] || die "No research folder $arg." 2
			check_research "$dir"
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
	[[ "$1" =~ $SLUG_RE ]] || die "The slug '$1' must be kebab-case." 2
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

cmd_init() {
	local slug=${1-} dir depth=standard artifacts="[]" type
	[[ -n "$slug" ]] || usage
	shift
	parse_common "$@"
	set -- ${REST[@]+"${REST[@]}"}
	while (($#)); do
		case $1 in
		--depth) depth=${2-}; shift 2 || usage ;;
		--artifact)
			one_of "${2-}" $(optional_types) || die "--artifact must be one of: $(optional_types | tr '\n' ' ')" 2
			artifacts=$(jq -c --arg a "$2" 'if index($a) then . else . + [$a] end' <<<"$artifacts")
			shift 2
			;;
		*) usage ;;
		esac
	done
	one_of "$depth" $DEPTHS || die "--depth must be one of: $DEPTHS." 2
	dir=$(research_dir "$slug") || exit 2
	[[ ! -e "$dir" ]] || die "$dir exists already."
	mkdir -p "$dir"
	for type in $(required_types); do
		new_artifact "$dir/$type.md" "$type"
	done
	DEPTH=$depth ARTIFACTS=$artifacts set_fields "$dir/brief.md" \
		'.depth = strenv(DEPTH) | .artifacts = env(ARTIFACTS) | .artifacts style="" | .artifacts[] style=""'
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
	[[ -f "$brief" ]] || die "No research $slug. Run research.sh init first."
	one_of "$type" $(optional_types) || die "The type must be one of: $(optional_types | tr '\n' ' '). init creates the others." 2
	file="$dir/$type.md"
	if [[ -n "$name" ]]; then
		[[ "$name" =~ $SLUG_RE ]] || die "--name must be kebab-case." 2
		[[ $(type_flag "$type" repeatable) == true ]] || die "A $type is not repeatable, so it takes no --name." 2
		file="$dir/$type-$name.md"
	fi
	[[ ! -e "$file" ]] || die "$file exists already."
	if ! one_of "$type" $(field "$brief" artifacts); then
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
	*) die "$name cannot move from $old to $new. Allowed: draft>review, review>draft, review>final, final>superseded." ;;
	esac
	if [[ "$new" == superseded ]]; then
		[[ -n "$by" && "$by" != "$slug" && -d "$ROOT_DIR/$by" ]] ||
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

command=${1-}
(($#)) && shift
case $command in
init) cmd_init "$@" ;;
add) cmd_add "$@" ;;
source) cmd_source "$@" ;;
cite) cmd_cite "$@" ;;
status) cmd_status "$@" ;;
check) cmd_check "$@" ;;
*) usage ;;
esac
