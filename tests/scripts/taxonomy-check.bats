#!/usr/bin/env bats

# scripts/taxonomy-check.sh keeps the label taxonomy in one piece. The
# issue forms, the Dependabot config and .github/labels.yml must agree, or
# a new issue gets a label that does not exist, or none. It runs in
# pre-commit and CI. Each test starts from a small valid taxonomy and
# breaks one rule. The tests use the real yq, because the script is yq code.

load helpers/common

setup() {
	sandbox taxonomy-check.sh
	S=scripts/taxonomy-check.sh
	L=.github/labels.yml
	F=.github/ISSUE_TEMPLATE
	fixture "$L" <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Something is broken"}
		- {name: "type:feature", color: "a2eeef", description: "A new capability"}
		- {name: "scope:ci", color: "0e8a16", description: "CI and workflows"}
		- {name: "scope:docs", color: "0075ca", description: "Documentation"}
		- {name: "pr:needs-review", color: "fbca04", description: "Waits for a review"}
	EOF
	form bug "type:bug" "ci, docs"
	form feature "type:feature" "ci, docs"
	fixture "$F/config.yml" <<-'EOF'
		blank_issues_enabled: false
		contact_links:
		  - name: Questions
		    url: https://example.com/questions
		    about: Ask here
	EOF
	fixture .github/dependabot.yml <<-'EOF'
		version: 2
		updates:
		  - package-ecosystem: github-actions
		    directory: /
		    schedule:
		      interval: weekly
		    labels: [scope:ci]
	EOF
}

# Write the issue form $F/$1.yml. $2 lists its labels and $3 the options of
# its scope dropdown, both as comma-separated words. $4 is the value of
# validations.required, true by default.
form() {
	fixture "$F/$1.yml" <<-EOF
		name: $1
		description: A form
		labels: [$2]
		body:
		  - type: dropdown
		    id: scope
		    attributes:
		      label: Scope
		      options: [$3]
		    validations:
		      required: ${4:-true}
	EOF
}

# Add the label $1, a YAML flow map, to the end of labels.yml.
add_label() {
	echo "- $1" >>"$L"
}

@test "passes a valid taxonomy and prints nothing" {
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "accepts upper-case hex digits in a color" {
	add_label '{name: "pr:blocked", color: "ABCDEF", description: "Blocked"}'
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "labels: reports a duplicate label name" {
	add_label '{name: "pr:needs-review", color: "fbca04", description: "Again"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: duplicate labels: pr:needs-review" ]
}

@test "labels: reports a name without a valid prefix or with upper case" {
	add_label '{name: "bug", color: "d73a4a", description: "No prefix"}'
	add_label '{name: "pr:Needs-Work", color: "d73a4a", description: "Upper case"}'
	add_label '{name: "pr:needs_work", color: "d73a4a", description: "Underscore"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == "$(printf '%s\n' \
		".github/labels.yml: bug: the name must be type:<x>, scope:<x> or pr:<x> in lower case." \
		".github/labels.yml: pr:Needs-Work: the name must be type:<x>, scope:<x> or pr:<x> in lower case." \
		".github/labels.yml: pr:needs_work: the name must be type:<x>, scope:<x> or pr:<x> in lower case.")" ]
}

@test "labels: reports a color that is not quoted" {
	# YAML reads the unquoted 123456 as a number, and the sync would break.
	add_label '{name: "pr:plain", color: 123456, description: "Unquoted"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: pr:plain: the color must be 6 hex digits in quotes." ]
}

@test "labels: reports a label without a color" {
	add_label '{name: "pr:plain", description: "No color"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: pr:plain: the color must be 6 hex digits in quotes." ]
}

@test "labels: reports a color that is not 6 hex digits" {
	add_label '{name: "pr:short", color: "12345", description: "Too short"}'
	add_label '{name: "pr:long", color: "1234567", description: "Too long"}'
	add_label '{name: "pr:nothex", color: "12345g", description: "Not hex"}'
	add_label '{name: "pr:hash", color: "#d73a4a", description: "With hash"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == "$(printf '%s\n' \
		".github/labels.yml: pr:short: the color must be 6 hex digits in quotes." \
		".github/labels.yml: pr:long: the color must be 6 hex digits in quotes." \
		".github/labels.yml: pr:nothex: the color must be 6 hex digits in quotes." \
		".github/labels.yml: pr:hash: the color must be 6 hex digits in quotes.")" ]
}

@test "labels: reports a missing description" {
	add_label '{name: "pr:plain", color: "d73a4a"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: pr:plain: the description must have 1 to 100 characters." ]
}

@test "labels: reports an empty description" {
	add_label '{name: "pr:plain", color: "d73a4a", description: ""}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: pr:plain: the description must have 1 to 100 characters." ]
}

@test "labels: reports a description of 101 characters, and accepts 100" {
	local at_limit over_limit
	at_limit=$(printf '%100s' '' | tr ' ' x)
	over_limit=$(printf '%101s' '' | tr ' ' x)
	add_label "{name: \"pr:ok\", color: \"d73a4a\", description: \"$at_limit\"}"
	run "$S"
	[ "$status" -eq 0 ]
	add_label "{name: \"pr:long\", color: \"d73a4a\", description: \"$over_limit\"}"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/labels.yml: pr:long: the description must have 1 to 100 characters." ]
}

@test "forms: reports a form label that is not in labels.yml" {
	form bug "type:bug, ghost" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE/bug.yml: label ghost is not in .github/labels.yml." ]
}

@test "forms: reports a pr:* label on a form, because pr:* labels flag pull requests" {
	form bug "type:bug, pr:needs-review" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE/bug.yml: label pr:needs-review flags pull requests, so no form may set it." ]
}

@test "forms: reports a form with no type label, and the type that then has no form" {
	form bug "scope:ci" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == "$(printf '%s\n' \
		".github/ISSUE_TEMPLATE/bug.yml: needs exactly one type:* label." \
		".github/ISSUE_TEMPLATE: no form for type:bug.")" ]
}

@test "forms: reports a form with two type labels" {
	form bug "type:bug, type:feature" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[[ "$output" == *".github/ISSUE_TEMPLATE/bug.yml: needs exactly one type:* label."* ]] || false
}

@test "forms: reports a form without a scope dropdown" {
	fixture "$F/bug.yml" <<-'EOF'
		name: bug
		description: A form
		labels: [type:bug]
		body:
		  - type: textarea
		    id: summary
		    attributes:
		      label: Summary
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[[ "$output" == *".github/ISSUE_TEMPLATE/bug.yml: needs a dropdown with id scope."* ]] || false
}

@test "forms: reports a scope field that is not a dropdown" {
	fixture "$F/bug.yml" <<-'EOF'
		name: bug
		description: A form
		labels: [type:bug]
		body:
		  - type: input
		    id: scope
		    attributes:
		      label: Scope
		    validations:
		      required: true
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[[ "$output" == *".github/ISSUE_TEMPLATE/bug.yml: needs a dropdown with id scope."* ]] || false
}

@test "forms: reports a scope dropdown that is not required" {
	form bug "type:bug" "ci, docs" false
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE/bug.yml: the scope dropdown must be required." ]
}

@test "forms: reports a scope dropdown without a validations block" {
	fixture "$F/bug.yml" <<-'EOF'
		name: bug
		description: A form
		labels: [type:bug]
		body:
		  - type: dropdown
		    id: scope
		    attributes:
		      label: Scope
		      options: [ci, docs]
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE/bug.yml: the scope dropdown must be required." ]
}

@test "forms: reports scope options in the wrong order" {
	form bug "type:bug" "docs, ci"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE/bug.yml: the scope options must be, in this order: ci docs" ]
}

@test "forms: reports a scope option that no scope label has, and a missing one" {
	form bug "type:bug" "ci, docs, other"
	form feature "type:feature" "ci"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == "$(printf '%s\n' \
		".github/ISSUE_TEMPLATE/bug.yml: the scope options must be, in this order: ci docs" \
		".github/ISSUE_TEMPLATE/feature.yml: the scope options must be, in this order: ci docs")" ]
}

@test "forms: checks every form, not only the first" {
	form bug "type:bug, ghost" "ci, docs"
	form feature "type:feature, phantom" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[[ "$output" == *"bug.yml: label ghost is not in"* && "$output" == *"feature.yml: label phantom is not in"* ]] || false
}

@test "forms: ignores config.yml, which is not a form" {
	# config.yml has no labels and no body, so a form check would fail it.
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	[ -f "$F/config.yml" ]
}

@test "coverage: reports a type label that has no form" {
	add_label '{name: "type:chore", color: "cfd3d7", description: "Maintenance"}'
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE: no form for type:chore." ]
}

@test "coverage: reports two forms for one type label" {
	form bug-again "type:bug" "ci, docs"
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/ISSUE_TEMPLATE: more than one form for type:bug." ]
}

@test "dependabot: reports a label that is not in labels.yml" {
	fixture .github/dependabot.yml <<-'EOF'
		version: 2
		updates:
		  - package-ecosystem: github-actions
		    directory: /
		    schedule:
		      interval: weekly
		    labels: [scope:ci, dependencies]
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/dependabot.yml: label dependencies is not in .github/labels.yml." ]
}

@test "dependabot: checks the labels of every update entry" {
	fixture .github/dependabot.yml <<-'EOF'
		version: 2
		updates:
		  - package-ecosystem: github-actions
		    directory: /
		    schedule:
		      interval: weekly
		    labels: [scope:ci]
		  - package-ecosystem: npm
		    directory: /
		    schedule:
		      interval: weekly
		    labels: [scope:web]
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[ "$output" == ".github/dependabot.yml: label scope:web is not in .github/labels.yml." ]
}

@test "dependabot: passes when dependabot.yml does not exist" {
	rm .github/dependabot.yml
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "dependabot: passes an update entry that sets no labels" {
	fixture .github/dependabot.yml <<-'EOF'
		version: 2
		updates:
		  - package-ecosystem: github-actions
		    directory: /
		    schedule:
		      interval: weekly
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "reports every problem of a run, not only the first" {
	add_label '{name: "pr:needs-review", color: "fbca04", description: "Again"}'
	add_label '{name: "pr:plain", color: "12345", description: "Short color"}'
	form bug "type:bug, ghost" "ci, docs" false
	fixture .github/dependabot.yml <<-'EOF'
		version: 2
		updates:
		  - package-ecosystem: github-actions
		    directory: /
		    schedule:
		      interval: weekly
		    labels: [scope:nope]
	EOF
	run "$S"
	[ "$status" -eq 1 ]
	[[ "$output" == *".github/labels.yml: duplicate labels: pr:needs-review"* ]] || false
	[[ "$output" == *".github/labels.yml: pr:plain: the color must be 6 hex digits in quotes."* ]] || false
	[[ "$output" == *".github/ISSUE_TEMPLATE/bug.yml: label ghost is not in .github/labels.yml."* ]] || false
	[[ "$output" == *".github/ISSUE_TEMPLATE/bug.yml: the scope dropdown must be required."* ]] || false
	[[ "$output" == *".github/dependabot.yml: label scope:nope is not in .github/labels.yml."* ]] || false
}
