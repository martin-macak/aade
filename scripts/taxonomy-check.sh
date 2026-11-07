#!/usr/bin/env bash

# Check that the issue forms and .github/labels.yml agree.
# - Each label has a unique name, a quoted 6-digit hex color and a
#   description of at most 100 characters.
# - Each label is a type:*, a scope:* or a pr:* label. pr:* labels flag
#   pull requests, so no form uses them.
# - Each form sets exactly one type:* label, and each type:* label has
#   exactly one form. Every label of a form exists in labels.yml.
# - The Scope dropdown of each form lists the scope:* values of labels.yml,
#   in the same order.
# - Each label that Dependabot sets exists in labels.yml.
# Run it from the repository root. Prints every problem and exits 1 when it
# finds one.

LABELS=.github/labels.yml
FORMS=.github/ISSUE_TEMPLATE
STATUS=0

fail() {
	>&2 echo "$1"
	STATUS=1
}

names=$(yq '.[].name' "$LABELS")
dupes=$(sort <<<"$names" | uniq -d)
[[ -z "$dupes" ]] || fail "$LABELS: duplicate labels: $dupes"
while IFS= read -r bad; do
	[[ -n "$bad" ]] && fail "$LABELS: $bad"
done < <(yq '.[] | select((.name | test("^(type|scope|pr):[a-z0-9-]+$") | not)) | .name + ": the name must be type:<x>, scope:<x> or pr:<x> in lower case."' "$LABELS"
	yq '.[] | select((.color | tag) != "!!str") | .name + ": the color must be 6 hex digits in quotes."' "$LABELS"
	yq '.[] | select((.color | tag) == "!!str") | select(.color | test("^[0-9a-fA-F]{6}$") | not) | .name + ": the color must be 6 hex digits in quotes."' "$LABELS"
	yq '.[] | select((.description // "" | length) == 0 or (.description | length) > 100) | .name + ": the description must have 1 to 100 characters."' "$LABELS")

scopes=$(grep '^scope:' <<<"$names" | sed 's/^scope://')
types=$(grep '^type:' <<<"$names")

form_types=""
for form in "$FORMS"/*.yml; do
	[[ "$(basename "$form")" == config.yml ]] && continue
	labels=$(yq '.labels[]' "$form")
	while IFS= read -r label; do
		[[ -z "$label" ]] && continue
		grep -qx "$label" <<<"$names" || fail "$form: label $label is not in $LABELS."
	done <<<"$labels"
	own=$(grep '^type:' <<<"$labels")
	if [[ $(grep -c . <<<"$own") -ne 1 ]]; then
		fail "$form: needs exactly one type:* label."
	else
		form_types+="$own"$'\n'
	fi
	options=$(yq '.body[] | select(.id == "scope") | .attributes.options[]' "$form")
	[[ "$(yq '.body[] | select(.id == "scope") | .type' "$form")" == dropdown ]] ||
		fail "$form: needs a dropdown with id scope."
	[[ "$(yq '.body[] | select(.id == "scope") | .validations.required' "$form")" == true ]] ||
		fail "$form: the scope dropdown must be required."
	[[ "$options" == "$scopes" ]] ||
		fail "$form: the scope options must be, in this order: $(echo $scopes)"
done

DEPENDABOT=.github/dependabot.yml
if [[ -f "$DEPENDABOT" ]]; then
	while IFS= read -r label; do
		[[ -z "$label" ]] && continue
		grep -qx -- "$label" <<<"$names" || fail "$DEPENDABOT: label $label is not in $LABELS."
	done < <(yq '.updates[].labels[]' "$DEPENDABOT")
fi

missing=$(comm -23 <(sort <<<"$types") <(grep . <<<"$form_types" | sort))
extra=$(grep . <<<"$form_types" | sort | uniq -d)
[[ -z "$missing" ]] || fail "$FORMS: no form for $(echo $missing)."
[[ -z "$extra" ]] || fail "$FORMS: more than one form for $(echo $extra)."

exit $STATUS
