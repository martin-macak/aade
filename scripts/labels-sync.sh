#!/usr/bin/env bash

# Make the labels of the GitHub repository equal .github/labels.yml.
# Usage: labels-sync.sh [--dry-run]
# It creates each missing label, updates each changed one, renames a label
# that has a `from` key, and deletes every label that the file does not
# list. --dry-run prints the plan and changes nothing.
# gh picks the repository from the git remote, or from GH_REPO. It needs a
# token that can write issues. Run it from the repository root.
# Exit codes: 0 done, 1 a gh call failed, 2 wrong usage.

set -uo pipefail

LABELS=.github/labels.yml
DRY_RUN=false
case ${1:-} in
--dry-run) DRY_RUN=true ;;
"") ;;
*)
	>&2 echo "Usage: labels-sync.sh [--dry-run]"
	exit 2
	;;
esac
if [[ ! -f "$LABELS" ]]; then
	>&2 echo "Run labels-sync.sh from the repository root. $LABELS is missing."
	exit 2
fi

STATUS=0

# Print the action, and run it unless this is a dry run.
run() {
	echo "$1"
	shift
	$DRY_RUN && return 0
	"$@" || STATUS=1
}

current=$(gh label list --limit 1000 --json name,color,description) || exit 1
desired=$(yq -o json -I 0 '.' "$LABELS") || exit 2

# Print the current label with the name $1 as compact JSON, or nothing.
current_label() {
	jq -c --arg name "$1" '.[] | select(.name == $name)' <<<"$current"
}

kept=()
while IFS= read -r label; do
	name=$(jq -r '.name' <<<"$label")
	color=$(jq -r '.color | ascii_downcase' <<<"$label")
	description=$(jq -r '.description // ""' <<<"$label")
	from=$(jq -r '.from // ""' <<<"$label")
	kept+=("$name")
	have=$(current_label "$name")
	if [[ -z "$have" && -n "$from" && -n "$(current_label "$from")" ]]; then
		kept+=("$from")
		run "rename $from -> $name" gh label edit "$from" --name "$name" --color "$color" --description "$description"
	elif [[ -z "$have" ]]; then
		run "create $name" gh label create "$name" --color "$color" --description "$description"
	elif [[ "$(jq -r '.color | ascii_downcase' <<<"$have")" != "$color" ||
		"$(jq -r '.description' <<<"$have")" != "$description" ]]; then
		run "update $name" gh label edit "$name" --color "$color" --description "$description"
	fi
done < <(jq -c '.[]' <<<"$desired")

while IFS= read -r name; do
	# The ${kept[@]+...} form keeps an empty array legal under set -u in bash 3.2.
	for keep in ${kept[@]+"${kept[@]}"}; do
		[[ "$name" == "$keep" ]] && continue 2
	done
	run "delete $name" gh label delete "$name" --yes
done < <(jq -r '.[].name' <<<"$current")

exit $STATUS
