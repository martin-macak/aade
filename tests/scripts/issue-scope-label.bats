#!/usr/bin/env bats

# scripts/issue-scope-label.sh keeps the scope:<x> label of an issue in
# line with the Scope section of its body. A person who edits the dropdown
# of an issue form changes only the body, so a workflow runs this script to
# fix the label. The body is untrusted input. The tests use a sandbox
# labels.yml and a fake gh. No test calls GitHub.

load helpers/common

setup() {
	sandbox issue-scope-label.sh
	S=scripts/issue-scope-label.sh
	fixture .github/labels.yml <<-'EOF'
		- name: type:task
		  color: "ededed"
		- name: scope:alpha
		  color: "ededed"
		- name: scope:beta
		  color: "ededed"
		- name: scope:gamma-2
		  color: "ededed"
	EOF
	# A test that sets no issue gets a failing `issue view`.
	fake_gh
	gh_reply "issue view" 99 </dev/null
}

# Make gh return an issue with the body $1 and the labels $2... .
issue() {
	local body=$1
	shift
	jq -n --arg body "$body" '{body: $body, labels: ($ARGS.positional | map({name: .}))}' \
		--args "$@" | gh_reply "issue view"
}

# Make gh return the raw JSON $1.
issue_json() {
	printf '%s' "$1" | gh_reply "issue view"
}

# The body of an issue form with the Scope value $1.
body() {
	printf '### What and why\n\nSome text.\n\n### Scope\n\n%s\n\n### Done when\n\nDone.\n' "$1"
}

@test "usage: no issue number exits 2" {
	run "$S"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage: issue-scope-label.sh <issue-number> [--dry-run]"* ]] || false
}

@test "usage: an issue number that is not a number exits 2" {
	for arg in abc 7x -1 '7 8' ''; do
		run "$S" "$arg"
		[ "$status" -eq 2 ]
		[[ "$output" == *"Usage:"* ]] || false
	done
}

@test "usage: a second argument other than --dry-run exits 2" {
	run "$S" 7 --force
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage:"* ]] || false
}

@test "usage: a third argument exits 2" {
	run "$S" 7 --dry-run extra
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage:"* ]] || false
}

@test "usage errors call no gh" {
	run "$S" abc
	run "$S" 7 --force
	[ -z "$(calls)" ]
}

@test "gh: asks for the body and the labels of the issue" {
	issue "$(body alpha)" type:task scope:alpha
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls)" = "gh issue view 7 --json body,labels" ]
}

@test "gh: a failing issue view exits 1 and edits nothing" {
	gh_reply "issue view" 4 </dev/null
	run "$S" 7
	[ "$status" -eq 1 ]
	[[ "$output" == *"gh: failed"* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope section: an issue without one keeps its labels, exit 0" {
	issue $'### What and why\n\nSome text.\n' type:task scope:beta
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"Issue #7 has no Scope section. Labels stay as they are."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope section: _No response_ counts as no section" {
	issue "$(body "_No response_")" type:task scope:beta
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"has no Scope section. Labels stay as they are."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope section: a heading with nothing below it counts as no section" {
	issue $'### Scope\n\n### Done when\n\nalpha\n' scope:beta
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"has no Scope section."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope section: a null body counts as no section" {
	issue_json '{"body": null, "labels": [{"name": "scope:beta"}]}'
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"has no Scope section."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope section: reads the first non-empty line below the heading" {
	issue $'### Scope\n\n\n\nalpha\nbeta\n' type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:alpha" ]
}

@test "scope section: ignores the text of other sections" {
	issue $'### What and why\n\nbeta\n\n### Scope\n\nalpha\n\n### Done when\n\ngamma-2\n' type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:alpha" ]
}

@test "scope section: a heading that only starts with Scope is another section" {
	issue $'### Scope notes\n\nalpha\n' type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"has no Scope section."* ]] || false
}

@test "scope section: reads a body with CRLF line ends" {
	issue $'### What and why\r\n\r\nSome text.\r\n\r\n### Scope\r\n\r\nalpha\r\n\r\n### Done when\r\n\r\nDone.\r\n' type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:alpha" ]
}

@test "scope section: trims spaces around the value" {
	issue "$(body '   alpha  ')" type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:alpha" ]
}

@test "scope value: text that is not a plain name exits 1 and edits nothing" {
	# The body is untrusted. These values must never reach a yq or jq filter.
	for value in 'x") | del(.)' 'Alpha' 'a b' '../etc' 'alpha;rm' '$(id)' 'alpha_beta'; do
		issue "$(body "$value")" type:task scope:beta
		run "$S" 7
		[ "$status" -eq 1 ]
		[ "$output" = "Issue #7: the Scope section is not a scope name." ]
		[[ "$(calls)" != *"issue edit"* ]] || false
	done
}

@test "scope value: a name without a label in labels.yml exits 1 and edits nothing" {
	issue "$(body delta)" type:task scope:beta
	run "$S" 7
	[ "$status" -eq 1 ]
	[[ "$output" == *"Issue #7: scope 'delta' has no label scope:delta in .github/labels.yml."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "scope value: matches a label as a whole line, not as a part" {
	issue "$(body alph)" type:task
	run "$S" 7
	[ "$status" -eq 1 ]
	[[ "$output" == *"scope 'alph' has no label scope:alph"* ]] || false
	issue "$(body gamma)" type:task
	run "$S" 7
	[ "$status" -eq 1 ]
}

@test "scope value: a name with digits and a hyphen is valid" {
	issue "$(body gamma-2)" type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:gamma-2" ]
}

@test "labels: adds the scope label when the issue has none" {
	issue "$(body alpha)" type:task
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"Issue #7: --add-label scope:alpha"* ]] || false
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --add-label scope:alpha" ]
}

@test "labels: swaps the old scope label for the new one and keeps other labels" {
	issue "$(body alpha)" type:task scope:beta
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"Issue #7: --remove-label scope:beta --add-label scope:alpha"* ]] || false
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --remove-label scope:beta --add-label scope:alpha" ]
}

@test "labels: removes every old scope label, even one that labels.yml lacks" {
	issue "$(body alpha)" scope:beta type:task scope:old
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --remove-label scope:beta --remove-label scope:old --add-label scope:alpha" ]
}

@test "labels: removes the other scope labels and does not add the label that is there" {
	issue "$(body alpha)" scope:beta scope:alpha
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --remove-label scope:beta" ]
}

@test "labels: an issue that has only the right scope label needs no edit" {
	issue "$(body alpha)" type:task scope:alpha
	run "$S" 7
	[ "$status" -eq 0 ]
	[[ "$output" == *"Issue #7 already has only scope:alpha."* ]] || false
	[[ "$(calls)" != *"issue edit"* ]] || false
}

@test "labels: a label that only looks like the scope label is not the scope label" {
	issue "$(body alpha)" scope:alphabet
	run "$S" 7
	[ "$status" -eq 0 ]
	[ "$(calls | tail -n 1)" = "gh issue edit 7 --remove-label scope:alphabet --add-label scope:alpha" ]
}

@test "gh: a failing issue edit exits 1, whatever its own exit code" {
	issue "$(body alpha)"
	gh_reply "issue edit" 4 </dev/null
	run "$S" 7
	[ "$status" -eq 1 ]
	[[ "$output" == *"gh: failed"* ]] || false
}

@test "dry-run: prints the plan and edits nothing" {
	issue "$(body alpha)" type:task scope:beta
	run "$S" 7 --dry-run
	[ "$status" -eq 0 ]
	[ "$output" = "Issue #7: --remove-label scope:beta --add-label scope:alpha" ]
	[ "$(calls)" = "gh issue view 7 --json body,labels" ]
}

@test "dry-run: says so when there is nothing to do" {
	issue "$(body alpha)" scope:alpha
	run "$S" 7 --dry-run
	[ "$status" -eq 0 ]
	[ "$output" = "Issue #7 already has only scope:alpha." ]
	[ "$(calls)" = "gh issue view 7 --json body,labels" ]
}
