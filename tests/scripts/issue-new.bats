#!/usr/bin/env bats

# scripts/issue-new.sh opens an issue from a GitHub issue form, the way the
# web form would. It exists so that an agent gets the same body, headings
# and labels as a person, and so that a bad field fails before gh runs.
# stdin is YAML with `title` and one key per field id. The tests use small
# forms in a sandbox and a fake gh. No test calls GitHub.

load helpers/common

setup() {
	sandbox issue-new.sh
	S=scripts/issue-new.sh
	# A test that sets no reply gets a failing `issue create`.
	fake_gh
	gh_reply "issue create" 99 </dev/null

	fixture .github/ISSUE_TEMPLATE/config.yml <<-'EOF'
		blank_issues_enabled: false
	EOF
	fixture .github/ISSUE_TEMPLATE/note.yml <<-'EOF'
		name: Note
		description: A minimal form with an optional scope.
		labels: ["type:note"]
		body:
		  - type: textarea
		    id: text
		    attributes:
		      label: Text
		  - type: dropdown
		    id: scope
		    attributes:
		      label: Scope
		      options:
		        - alpha
	EOF
	fixture .github/ISSUE_TEMPLATE/task.yml <<-'EOF'
		name: Task
		description: A form with every kind of element.
		labels: ["type:task", "needs-triage"]
		body:
		  - type: markdown
		    attributes:
		      value: Read this before you fill the form.
		  - type: input
		    id: summary
		    attributes:
		      label: Short summary
		    validations:
		      required: true
		  - type: textarea
		    id: details
		    attributes:
		      label: Details
		  - type: textarea
		    id: log
		    attributes:
		      label: Log output
		      render: shell
		  - type: dropdown
		    id: scope
		    attributes:
		      label: Scope
		      options:
		        - alpha
		        - beta
		    validations:
		      required: true
		  - type: dropdown
		    id: severity
		    attributes:
		      label: Severity
		      options:
		        - low
		        - high
		  - type: markdown
		    attributes:
		      value: A second note between the fields.
		  - type: checkboxes
		    id: checks
		    attributes:
		      label: Checks
		      options:
		        - label: Tests pass
		        - label: Docs updated
	EOF
}

# The smallest valid input for the task form.
VALID=$'title: T\nsummary: S\nscope: alpha'

# Make gh create issue 1.
gh_creates() {
	gh_reply "issue create" <<<https://github.com/o/r/issues/1
}

@test "usage: no type exits 2 and lists the types, without config" {
	run "$S"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage: issue-new.sh <type> [--dry-run] < fields.yml"* ]] || false
	[[ "$output" == *"Types: note task"* ]] || false
	[[ "$output" != *config* ]] || false
}

@test "usage: an unknown type exits 2 and lists the types" {
	run "$S" nosuch
	[ "$status" -eq 2 ]
	[[ "$output" == *"Types: note task"* ]] || false
}

@test "usage: config is not a type, although config.yml exists" {
	run "$S" config
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage:"* && "$output" == *"Types: note task"* ]] || false
}

@test "usage: an extra argument exits 2" {
	run "$S" task --dry-run extra <<<"$VALID"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage:"* ]] || false
}

@test "usage: a second argument other than --dry-run exits 2" {
	run "$S" task --force <<<"$VALID"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Usage:"* ]] || false
}

@test "usage errors call no gh" {
	run "$S" nosuch
	run "$S" task --force <<<"$VALID"
	[ -z "$(calls)" ]
}

@test "stdin: text that is not a YAML map exits 2" {
	for input in 'just text' '- a
- b' '' 'a: ['; do
		run "$S" task --dry-run <<<"$input"
		[ "$status" -eq 2 ]
		[[ "$output" == *"stdin must be a YAML map of title and field ids."* ]] || false
	done
}

@test "title: is required" {
	run "$S" task --dry-run <<<$'summary: S\nscope: alpha'
	[ "$status" -eq 2 ]
	[[ "$output" == *"title: required."* ]] || false
}

@test "title: an empty title counts as missing" {
	run "$S" task --dry-run <<<$'title: ""\nsummary: S\nscope: alpha'
	[ "$status" -eq 2 ]
	[[ "$output" == *"title: required."* ]] || false
}

@test "keys: an unknown key exits 2 and names the fields of the form" {
	run "$S" task --dry-run <<<"$VALID"$'\nbogus: 1'
	[ "$status" -eq 2 ]
	[[ "$output" == *"bogus: the task form has no such field. Fields: summary details log scope severity checks"* ]] || false
}

@test "keys: a markdown element has no field id, so no key can name it" {
	run "$S" task --dry-run <<<"$VALID"$'\nmarkdown: x'
	[ "$status" -eq 2 ]
	[[ "$output" == *"markdown: the task form has no such field."* ]] || false
}

@test "required: a required field that is missing exits 2" {
	run "$S" task --dry-run <<<$'title: T\nscope: alpha'
	[ "$status" -eq 2 ]
	[[ "$output" == *"summary: required."* ]] || false
}

@test "required: a required dropdown that is missing exits 2 without an option error" {
	run "$S" task --dry-run <<<$'title: T\nsummary: S'
	[ "$status" -eq 2 ]
	[[ "$output" == *"scope: required."* ]] || false
	[[ "$output" != *"is not one of"* ]] || false
}

@test "dropdown: a value that is not an option exits 2 and lists the options" {
	run "$S" task --dry-run <<<$'title: T\nsummary: S\nscope: gamma'
	[ "$status" -eq 2 ]
	[[ "$output" == *"scope: 'gamma' is not one of: alpha beta"* ]] || false
}

@test "dropdown: a value must match an option as a whole, not as a part" {
	run "$S" task --dry-run <<<$'title: T\nsummary: S\nscope: alph'
	[ "$status" -eq 2 ]
	[[ "$output" == *"scope: 'alph' is not one of: alpha beta"* ]] || false
}

@test "dropdown: an optional dropdown may stay empty" {
	run "$S" task --dry-run <<<"$VALID"
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Severity\n\n_No response_'* ]] || false
}

@test "checkboxes: true checks every option" {
	run "$S" task --dry-run <<<"$VALID"$'\nchecks: true'
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Checks\n\n- [x] Tests pass\n- [x] Docs updated'* ]] || false
}

@test "checkboxes: false checks no option" {
	run "$S" task --dry-run <<<"$VALID"$'\nchecks: false'
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Checks\n\n- [ ] Tests pass\n- [ ] Docs updated'* ]] || false
}

@test "checkboxes: a field left out checks no option" {
	run "$S" task --dry-run <<<"$VALID"
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Checks\n\n- [ ] Tests pass\n- [ ] Docs updated'* ]] || false
}

@test "checkboxes: a list checks only the named options" {
	run "$S" task --dry-run <<<"$VALID"$'\nchecks:\n  - Docs updated'
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Checks\n\n- [ ] Tests pass\n- [x] Docs updated'* ]] || false
}

@test "checkboxes: a name that is not an option exits 2" {
	run "$S" task --dry-run <<<"$VALID"$'\nchecks:\n  - Tests pass\n  - Nope'
	[ "$status" -eq 2 ]
	[[ "$output" == *"checks: 'Nope' is not an option."* ]] || false
}

@test "render: a field with render wraps the value in a code fence of that language" {
	run "$S" task --dry-run <<<"$VALID"$'\nlog: |\n  line one\n  line two'
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Log output\n\n```shell\nline one\nline two\n```\n'* ]] || false
}

@test "render: an empty field gets _No response_, not an empty code fence" {
	run "$S" task --dry-run <<<"$VALID"
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Log output\n\n_No response_'* ]] || false
	[[ "$output" != *'```'* ]] || false
}

@test "body: an empty optional field gets _No response_, as the web form does" {
	run "$S" task --dry-run <<<"$VALID"
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Details\n\n_No response_'* ]] || false
}

@test "body: a field without render keeps its text as it is" {
	run "$S" task --dry-run <<<"$VALID"$'\ndetails: |\n  First line.\n\n  - item'
	[ "$status" -eq 0 ]
	[[ "$output" == *$'### Details\n\nFirst line.\n\n- item\n\n### Log output'* ]] || false
}

@test "body: markdown elements add no section" {
	run "$S" task --dry-run <<<"$VALID"
	[ "$status" -eq 0 ]
	[[ "$output" != *"Read this before"* && "$output" != *"A second note"* ]] || false
	[ "$(grep -c '^### ' <<<"$output")" -eq 6 ]
}

@test "body: sections follow the order of the form, not of the input" {
	run "$S" task --dry-run <<<$'scope: beta\nsummary: S\ntitle: T'
	[ "$status" -eq 0 ]
	expected=$'### Short summary\n\nS\n\n### Details\n\n_No response_\n\n### Log output\n\n_No response_\n\n### Scope\n\nbeta\n\n### Severity\n\n_No response_\n\n### Checks'
	[[ "$output" == *"$expected"* ]] || false
}

@test "labels: the labels of the form plus scope:<scope>" {
	run "$S" task --dry-run <<<$'title: T\nsummary: S\nscope: beta'
	[ "$status" -eq 0 ]
	[[ "$output" == *"Labels: type:task needs-triage scope:beta"* ]] || false
}

@test "labels: no scope value gives only the labels of the form" {
	run "$S" note --dry-run <<<'title: T'
	[ "$status" -eq 0 ]
	[[ "$output" == *"Labels: type:note"* && "$output" != *"scope:"* ]] || false
}

@test "dry-run: prints the title, the labels and the body, and calls no gh" {
	run "$S" task --dry-run <<<$'title: Fix the build\nsummary: Short one\nscope: alpha\nseverity: high\nchecks:\n  - Tests pass'
	[ "$status" -eq 0 ]
	expected=$(
		cat <<-'EOF'
			Title: Fix the build
			Labels: type:task needs-triage scope:alpha

			### Short summary

			Short one

			### Details

			_No response_

			### Log output

			_No response_

			### Scope

			alpha

			### Severity

			high

			### Checks

			- [x] Tests pass
			- [ ] Docs updated
		EOF
	)
	[ "$output" = "$expected" ]
	[ -z "$(calls)" ]
}

@test "dry-run: a field error still exits 2 and prints no title" {
	run "$S" task --dry-run <<<'title: T'
	[ "$status" -eq 2 ]
	[[ "$output" != *"Title:"* ]] || false
}

@test "run: pipes the body to gh issue create with the title and the labels" {
	gh_creates
	run "$S" task <<<$'title: Fix the build\nsummary: Short one\nscope: alpha\nchecks: true'
	[ "$status" -eq 0 ]
	# gh prints the URL of the new issue.
	[[ "$output" == *"https://github.com/o/r/issues/1"* ]] || false
	[ "$(calls)" = "gh issue create --title Fix the build --body-file - --label type:task --label needs-triage --label scope:alpha" ]
	# One <...> for each argument shows that the title stays one argument.
	[ "$(cat "$FAKE_DIR/gh.argv")" = '<issue><create><--title><Fix the build><--body-file><-><--label><type:task><--label><needs-triage><--label><scope:alpha>' ]
	expected_body=$(
		cat <<-'EOF'
			### Short summary

			Short one

			### Details

			_No response_

			### Log output

			_No response_

			### Scope

			alpha

			### Severity

			_No response_

			### Checks

			- [x] Tests pass
			- [x] Docs updated
		EOF
	)
	[ "$(cat "$FAKE_DIR/gh.stdin")" = "$expected_body" ]
}

@test "run: the body ends with one newline and equals the body of dry-run" {
	gh_creates
	run "$S" task <<<"$VALID"
	[ "$status" -eq 0 ]
	[ "$(tail -c 2 "$FAKE_DIR/gh.stdin" | od -An -c | tr -d ' ')" = 'd\n' ]
	run "$S" task --dry-run <<<"$VALID"
	[ "$(sed '1,3d' <<<"$output")" = "$(cat "$FAKE_DIR/gh.stdin")" ]
}

@test "run: a form error exits 2 and calls no gh" {
	run "$S" task <<<'title: T'
	[ "$status" -eq 2 ]
	[ -z "$(calls)" ]
}

@test "run: a failing gh exits 1, whatever its own exit code" {
	gh_reply "issue create" 4 </dev/null
	run "$S" task <<<"$VALID"
	[ "$status" -eq 1 ]
	[[ "$output" == *"gh: failed"* ]] || false
}

@test "errors: several problems are reported together, before anything is printed" {
	run "$S" task --dry-run <<<$'bogus: 1\nscope: gamma\nchecks:\n  - Nope'
	[ "$status" -eq 2 ]
	[[ "$output" == *"title: required."* ]] || false
	[[ "$output" == *"bogus: the task form has no such field."* ]] || false
	[[ "$output" == *"checks: 'Nope' is not an option."* ]] || false
	[[ "$output" == *"scope: 'gamma' is not one of: alpha beta"* ]] || false
	[[ "$output" == *"summary: required."* ]] || false
	[[ "$output" != *"Title:"* ]] || false
	[ -z "$(calls)" ]
}
