#!/usr/bin/env bash

# Set the scope:<x> label of an issue from the Scope section of its body.
# Usage: issue-scope-label.sh <issue-number> [--dry-run]
# An issue form renders the Scope dropdown as a "### Scope" heading and the
# value below it. The script adds scope:<value> and removes every other
# scope:* label. An issue without a Scope section keeps its labels.
# gh picks the repository from the git remote, or from GH_REPO. Run it from
# the repository root.
# Exit codes: 0 done or nothing to do, 1 unknown scope or a gh call failed,
# 2 wrong usage.

set -uo pipefail

LABELS=.github/labels.yml
issue=${1:-}
if [[ ! "$issue" =~ ^[0-9]+$ || ($# -eq 2 && "$2" != --dry-run) || $# -gt 2 ]]; then
	>&2 echo "Usage: issue-scope-label.sh <issue-number> [--dry-run]"
	exit 2
fi
DRY_RUN=false
[[ ${2:-} == --dry-run ]] && DRY_RUN=true

data=$(gh issue view "$issue" --json body,labels) || exit 1

# The first non-empty line after "### Scope", before the next heading.
scope=$(jq -r '.body // ""' <<<"$data" | tr -d '\r' | awk '
	/^### / { inside = ($0 == "### Scope"); next }
	inside && NF { print; exit }' | sed 's/^ *//; s/ *$//')
if [[ -z "$scope" || "$scope" == "_No response_" ]]; then
	echo "Issue #$issue has no Scope section. Labels stay as they are."
	exit 0
fi

# The body is untrusted input. Accept only a plain scope name, and compare
# it as a fixed string. It never goes into a yq or jq expression.
if [[ ! "$scope" =~ ^[a-z0-9-]+$ ]]; then
	>&2 echo "Issue #$issue: the Scope section is not a scope name."
	exit 1
fi
want="scope:$scope"
if ! grep -qxF -- "$want" <<<"$(yq '.[].name' "$LABELS")"; then
	>&2 echo "Issue #$issue: scope '$scope' has no label $want in $LABELS."
	exit 1
fi

args=()
while IFS= read -r label; do
	[[ "$label" != "$want" ]] && args+=(--remove-label "$label")
done < <(jq -r '.labels[].name | select(startswith("scope:"))' <<<"$data")
jq -e --arg want "$want" 'any(.labels[]; .name == $want)' <<<"$data" >/dev/null || args+=(--add-label "$want")

if ((${#args[@]} == 0)); then
	echo "Issue #$issue already has only $want."
	exit 0
fi
echo "Issue #$issue: ${args[*]}"
$DRY_RUN && exit 0
gh issue edit "$issue" "${args[@]}" || exit 1
