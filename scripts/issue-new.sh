#!/usr/bin/env bash

# Open an issue from an issue form, the way the web form would.
# Usage: issue-new.sh <type> [--dry-run] < fields.yml
# <type> names a form in .github/ISSUE_TEMPLATE, such as bug or chore.
# stdin is YAML: `title`, plus one key per field id of the form. A
# checkboxes field takes true (check all), false, or a list of the option
# labels to check. The script checks required fields and dropdown values,
# renders the body with the "### <label>" headings of a form, and sets the
# labels of the form plus scope:<scope>. --dry-run prints the title, labels
# and body and opens nothing. The issue-authoring skill explains its use.
# Run it from the repository root.
# Exit codes: 0 done, 1 gh failed, 2 wrong usage or invalid fields.

set -uo pipefail

FORMS=.github/ISSUE_TEMPLATE
type=${1:-}
form="$FORMS/$type.yml"
if [[ -z "$type" || "$type" == config || ! -f "$form" || $# -gt 2 || ($# -eq 2 && "$2" != --dry-run) ]]; then
	>&2 echo "Usage: issue-new.sh <type> [--dry-run] < fields.yml"
	>&2 echo "Types: $(echo $(ls "$FORMS" | sed -n 's/\.yml$//p' | grep -vx config))"
	exit 2
fi
DRY_RUN=false
[[ ${2:-} == --dry-run ]] && DRY_RUN=true

input=$(mktemp)
trap 'rm -f "$input"' EXIT
cat >"$input"
yq -e 'tag == "!!map"' "$input" >/dev/null 2>&1 || {
	>&2 echo "stdin must be a YAML map of title and field ids."
	exit 2
}

ERRORS=0
error() {
	>&2 echo "$1"
	ERRORS=1
}

# Print the value of key $1 of the input. $2 is a yq filter for it.
value() { yq "(.[\"$1\"] // \"\") ${2:-}" "$input"; }

title=$(value title)
[[ -n "$title" ]] || error "title: required."

ids=$(yq '.body[] | select(.type != "markdown") | .id' "$form")
while IFS= read -r key; do
	[[ "$key" == title ]] && continue
	grep -qx "$key" <<<"$ids" || error "$key: the $type form has no such field. Fields: $(echo $ids)"
done < <(yq 'keys | .[]' "$input")

body=""
count=$(yq '.body | length' "$form")
for ((i = 0; i < count; i++)); do
	el=".body[$i]"
	kind=$(yq "$el.type" "$form")
	[[ "$kind" == markdown ]] && continue
	id=$(yq "$el.id" "$form")
	label=$(yq "$el.attributes.label" "$form")
	required=$(yq "$el.validations.required // false" "$form")
	case $kind in
	checkboxes)
		# Newline-separated lists, because macOS bash 3.2 has no mapfile.
		options=$(yq "$el.attributes.options[].label" "$form")
		if [[ "$(yq "(.[\"$id\"] // false) | tag" "$input")" == "!!seq" ]]; then
			checked=$(value "$id" '| .[]')
			while IFS= read -r c; do
				grep -qxF -- "$c" <<<"$options" || error "$id: '$c' is not an option."
			done <<<"$checked"
		elif [[ "$(value "$id")" == true ]]; then
			checked=$options
		else
			checked=""
		fi
		text=""
		while IFS= read -r o; do
			mark=" "
			grep -qxF -- "$o" <<<"$checked" && mark=x
			text+="- [$mark] $o"$'\n'
		done <<<"$options"
		text=${text%$'\n'}
		;;
	*)
		text=$(value "$id")
		if [[ "$kind" == dropdown && -n "$text" ]]; then
			grep -qxF -- "$text" <<<"$(yq "$el.attributes.options[]" "$form")" ||
				error "$id: '$text' is not one of: $(echo $(yq "$el.attributes.options[]" "$form"))"
		fi
		if [[ -z "$text" ]]; then
			[[ "$required" == true ]] && error "$id: required."
			text="_No response_"
		elif [[ "$(yq "$el.attributes.render // \"\"" "$form")" != "" ]]; then
			text=$'```'"$(yq "$el.attributes.render" "$form")"$'\n'"$text"$'\n```'
		fi
		;;
	esac
	body+="### $label"$'\n\n'"$text"$'\n\n'
done
((ERRORS)) && exit 2
body=${body%$'\n\n'}$'\n'

labels=$(yq '.labels[]' "$form")
scope=$(value scope)
[[ -n "$scope" ]] && labels+=$'\n'"scope:$scope"
label_args=()
while IFS= read -r l; do
	[[ -n "$l" ]] && label_args+=(--label "$l")
done <<<"$labels"

if $DRY_RUN; then
	echo "Title: $title"
	echo "Labels: $(echo $labels)"
	echo
	printf '%s' "$body"
	exit 0
fi
printf '%s' "$body" | gh issue create --title "$title" --body-file - "${label_args[@]}" || exit 1
