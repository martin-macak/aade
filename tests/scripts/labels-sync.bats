#!/usr/bin/env bats

# scripts/labels-sync.sh makes the labels of the GitHub repository equal to
# .github/labels.yml, so the file is the one source of truth. It creates,
# updates, renames and deletes labels through gh. With --dry-run it only
# prints the plan. These tests fake gh: it answers `label list` from a JSON
# reply and logs every other call, so no test touches GitHub.

load helpers/common

setup() {
	sandbox labels-sync.sh
	S=scripts/labels-sync.sh
	LIST_CALL='gh label list --limit 1000 --json name,color,description'
	# The fake gh answers `label list` with the labels that GitHub has now,
	# none at first. gh_reply makes a call fail, such as "label create".
	fake_gh
	gh_reply "label list" <<<'[]'
}

# Set the labels that GitHub has now. Pass them as JSON on stdin.
github_has() {
	gh_reply "label list"
}

# Pass when gh got the label list call and then exactly the calls "$@".
gh_got() {
	local expected actual
	expected=$(printf '%s\n' "$LIST_CALL" "$@")
	actual=$(calls)
	[ "$actual" == "$expected" ] || {
		printf 'expected calls:\n%s\nactual calls:\n%s\n' "$expected" "$actual" >&2
		return 1
	}
}

@test "rejects an unknown argument with usage help and exit 2" {
	run "$S" --apply
	[ "$status" -eq 2 ]
	[ "$output" == "Usage: labels-sync.sh [--dry-run]" ]
	[ -z "$(calls)" ]
}

@test "exits 2 and names the file when .github/labels.yml is missing" {
	run "$S"
	[ "$status" -eq 2 ]
	[[ "$output" == *"Run labels-sync.sh from the repository root. .github/labels.yml is missing."* ]] || false
	[ -z "$(calls)" ]
}

@test "exits 1 and writes nothing when gh cannot list the labels" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Bug"}
	EOF
	gh_reply "label list" 1 </dev/null
	run "$S"
	[ "$status" -eq 1 ]
	gh_got
}

@test "exits 2 and writes nothing when labels.yml is not valid YAML" {
	printf 'a: [unclosed\n' | fixture .github/labels.yml
	run "$S"
	[ "$status" -eq 2 ]
	gh_got
}

@test "asks gh for up to 1000 labels with name, color and description" {
	echo '[]' | fixture .github/labels.yml
	run "$S"
	[ "$status" -eq 0 ]
	gh_got
}

@test "creates a label that GitHub does not have" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Something is broken"}
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "create type:bug" ]
	gh_got 'gh label create type:bug --color d73a4a --description Something is broken'
}

@test "sends the color in lower case" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "D73A4A", description: "Bug"}
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	gh_got 'gh label create type:bug --color d73a4a --description Bug'
}

@test "passes name, color and description as separate gh arguments" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Two words here"}
		- {name: "scope:ci", color: "0e8a16"}
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	grep -qxF '<label><create><type:bug><--color><d73a4a><--description><Two words here>' "$FAKE_DIR/gh.argv"
	# A label without description gets an empty description argument.
	grep -qxF '<label><create><scope:ci><--color><0e8a16><--description><>' "$FAKE_DIR/gh.argv"
}

@test "updates a label whose color changed" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Bug"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"000000","description":"Bug"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "update type:bug" ]
	gh_got 'gh label edit type:bug --color d73a4a --description Bug'
}

@test "updates a label whose description changed" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Something is broken"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"d73a4a","description":"Bug"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "update type:bug" ]
	gh_got 'gh label edit type:bug --color d73a4a --description Something is broken'
}

@test "updates a label whose description is now empty in the file" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"d73a4a","description":"Bug"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "update type:bug" ]
	grep -qxF '<label><edit><type:bug><--color><d73a4a><--description><>' "$FAKE_DIR/gh.argv"
}

@test "compares colors without case, so ABCDEF and abcdef are the same" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:a", color: "abcdef", description: "A"}
		- {name: "type:b", color: "ABCDEF", description: "B"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:a","color":"ABCDEF","description":"A"},
		 {"name":"type:b","color":"abcdef","description":"B"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	gh_got
}

@test "changes nothing when GitHub already matches the file" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Bug"}
		- {name: "scope:ci", color: "0e8a16", description: "CI"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"d73a4a","description":"Bug"},
		 {"name":"scope:ci","color":"0e8a16","description":"CI"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	gh_got
}

@test "renames the old label when from names one that exists, and keeps it from deletion" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:feature", from: "type:enhancement", color: "a2eeef", description: "New"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:enhancement","color":"a2eeef","description":"New"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "rename type:enhancement -> type:feature" ]
	gh_got 'gh label edit type:enhancement --name type:feature --color a2eeef --description New'
}

@test "creates the label when from names a label that does not exist" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:feature", from: "type:enhancement", color: "a2eeef", description: "New"}
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "create type:feature" ]
	gh_got 'gh label create type:feature --color a2eeef --description New'
}

@test "does nothing on a second run after a rename" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:feature", from: "type:enhancement", color: "a2eeef", description: "New"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:feature","color":"a2eeef","description":"New"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	gh_got
}

@test "ignores from when the new label exists, and deletes the old one" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:feature", from: "type:enhancement", color: "a2eeef", description: "New"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:feature","color":"a2eeef","description":"New"},
		 {"name":"type:enhancement","color":"a2eeef","description":"New"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "delete type:enhancement" ]
	gh_got 'gh label delete type:enhancement --yes'
}

@test "deletes labels that the file does not list" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Bug"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"d73a4a","description":"Bug"},
		 {"name":"good first issue","color":"7057ff","description":"Old"},
		 {"name":"wontfix","color":"ffffff","description":""}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == $'delete good first issue\ndelete wontfix' ]
	gh_got 'gh label delete good first issue --yes' 'gh label delete wontfix --yes'
	grep -qxF '<label><delete><good first issue><--yes>' "$FAKE_DIR/gh.argv"
}

@test "exits 2 and deletes nothing when labels.yml is empty, a comment, null or not a list" {
	github_has <<-'EOF'
		[{"name":"keep","color":"ffffff","description":""}]
	EOF
	for content in "" "# only a comment" "null" "name: type:bug"; do
		printf '%s\n' "$content" | fixture .github/labels.yml
		: >"$BATS_TEST_TMPDIR/fake.log"
		run "$S"
		[ "$status" -eq 2 ] || {
			echo "'$content': exit $status"
			return 1
		}
		[[ "$output" == *".github/labels.yml must be a list of labels."* ]] || false
		gh_got
	done
}

@test "deletes every label when the file lists none" {
	# Bash 3.2 (macOS) fails on the empty array of kept labels under set -u.
	echo '[]' | fixture .github/labels.yml
	github_has <<-'EOF'
		[{"name":"wontfix","color":"ffffff","description":""}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == "delete wontfix" ]
	gh_got 'gh label delete wontfix --yes'
}

@test "creates, updates, renames and deletes in one run, in file order and then deletes last" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:new", color: "111111", description: "New"}
		- {name: "type:changed", color: "222222", description: "Changed"}
		- {name: "type:renamed", from: "type:old", color: "333333", description: "Renamed"}
		- {name: "type:same", color: "444444", description: "Same"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:changed","color":"000000","description":"Changed"},
		 {"name":"type:old","color":"333333","description":"Renamed"},
		 {"name":"type:same","color":"444444","description":"Same"},
		 {"name":"scope:stale","color":"555555","description":"Stale"}]
	EOF
	run "$S"
	[ "$status" -eq 0 ]
	[ "$output" == $'create type:new\nupdate type:changed\nrename type:old -> type:renamed\ndelete scope:stale' ]
	gh_got \
		'gh label create type:new --color 111111 --description New' \
		'gh label edit type:changed --color 222222 --description Changed' \
		'gh label edit type:old --name type:renamed --color 333333 --description Renamed' \
		'gh label delete scope:stale --yes'
}

@test "--dry-run prints the plan and calls no write" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:new", color: "111111", description: "New"}
		- {name: "type:changed", color: "222222", description: "Changed"}
		- {name: "type:renamed", from: "type:old", color: "333333", description: "Renamed"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:changed","color":"000000","description":"Changed"},
		 {"name":"type:old","color":"333333","description":"Renamed"},
		 {"name":"scope:stale","color":"555555","description":"Stale"}]
	EOF
	run "$S" --dry-run
	[ "$status" -eq 0 ]
	[ "$output" == $'create type:new\nupdate type:changed\nrename type:old -> type:renamed\ndelete scope:stale' ]
	gh_got
}

@test "--dry-run prints nothing when GitHub already matches the file" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:bug", color: "d73a4a", description: "Bug"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:bug","color":"d73a4a","description":"Bug"}]
	EOF
	run "$S" --dry-run
	[ "$status" -eq 0 ]
	[ -z "$output" ]
	gh_got
}

@test "a failing create exits 1 but still runs the other actions" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:new", color: "111111", description: "New"}
		- {name: "type:changed", color: "222222", description: "Changed"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:changed","color":"000000","description":"Changed"},
		 {"name":"scope:stale","color":"555555","description":"Stale"}]
	EOF
	gh_reply "label create" 1 </dev/null
	run "$S"
	[ "$status" -eq 1 ]
	gh_got \
		'gh label create type:new --color 111111 --description New' \
		'gh label edit type:changed --color 222222 --description Changed' \
		'gh label delete scope:stale --yes'
}

@test "a failing delete exits 1 and the earlier actions stay done" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:new", color: "111111", description: "New"}
	EOF
	github_has <<-'EOF'
		[{"name":"scope:stale","color":"555555","description":"Stale"}]
	EOF
	gh_reply "label delete" 1 </dev/null
	run "$S"
	[ "$status" -eq 1 ]
	gh_got \
		'gh label create type:new --color 111111 --description New' \
		'gh label delete scope:stale --yes'
}

@test "a failing rename exits 1 and keeps the old label from deletion" {
	fixture .github/labels.yml <<-'EOF'
		- {name: "type:feature", from: "type:enhancement", color: "a2eeef", description: "New"}
	EOF
	github_has <<-'EOF'
		[{"name":"type:enhancement","color":"a2eeef","description":"New"}]
	EOF
	gh_reply "label edit" 1 </dev/null
	run "$S"
	[ "$status" -eq 1 ]
	gh_got 'gh label edit type:enhancement --name type:feature --color a2eeef --description New'
}
