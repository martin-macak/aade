#!/usr/bin/env bats

# The helpers of tests/scripts/helpers keep every suite offline and away
# from the files and credentials of the developer. A gap in them lets a
# test that forgets a fake call a real API with real credentials, so the
# helpers get their own suite.

load helpers/common

@test "sandbox: drops the credentials and the tool settings of the caller" {
	export GH_TOKEN=t GITHUB_TOKEN=t GH_REPO=o/r XDG_CONFIG_HOME=/x DECISIONKIT_PROVIDER=p MISE_ENV=e
	sandbox
	[ -z "$(env | grep -E '^(GH_TOKEN|GITHUB_TOKEN|GH_REPO|XDG_CONFIG_HOME|DECISIONKIT_[A-Z_]*|MISE_[A-Z_]*)=')" ]
}

@test "sandbox: gh, decisionkit and claude fail until a test fakes them" {
	sandbox
	for cmd in gh decisionkit claude; do
		run "$cmd" issue list
		[ "$status" -eq 99 ]
		[ "$output" = "$cmd: this test has no fake for it. Fake it with tests/scripts/helpers/fakes.bash." ]
	done
	fake_gh
	run gh issue list
	[ "$status" -eq 0 ]
}

@test "unfake: removes a fake from PATH" {
	sandbox
	unfake decisionkit
	[ "$(command -v decisionkit)" != "$FAKE_BIN/decisionkit" ]
	[ ! -e "$FAKE_BIN/decisionkit" ]
}

@test "fake_mise: a child of the command of mise exec still gets the fakes" {
	sandbox
	fake_mise
	fake gh 'echo fake gh'
	run mise exec -- bash -c 'gh'
	[ "$status" -eq 0 ]
	[ "$output" = "fake gh" ]
}

@test "fake_mise: mise exec runs a real tool when the test did not fake it" {
	sandbox
	fake_mise
	run mise exec -- jq -n 1
	[ "$status" -eq 0 ]
	[ "$output" = 1 ]
}

@test "path_without: hides the named commands and keeps the others" {
	sandbox
	fake alpha
	fake beta
	run env PATH="$(path_without alpha)" bash -c 'command -v alpha; command -v beta'
	[ "$status" -eq 0 ]
	[ "$output" = "$(path_without alpha | cut -d: -f1)/beta" ]
}

@test "mise-tasks.bats fails, and does not skip, when mise is missing" {
	sandbox
	run env PATH="$(path_without mise)" "$BATS_ROOT/bin/bats" "$ROOT/tests/scripts/mise-tasks.bats"
	[ "$status" -ne 0 ]
	has "$output" "mise-tasks.bats needs mise on PATH."
	lacks "$output" "# skip"
}

@test "fake: links to the suite stub and writes no executable file" {
	sandbox
	fake alpha 'echo alpha'
	[ -L "$FAKE_BIN/alpha" ]
	[ "$(readlink "$FAKE_BIN/alpha")" = "$BATS_FILE_TMPDIR/copy$ROOT/tests/scripts/helpers/fake-stub" ]
	[ -z "$(find "$BATS_TEST_TMPDIR" -type f -perm -u+x)" ]
	run alpha one
	[ "$output" = alpha ]
	[ "$(calls)" = "alpha one" ]
}

@test "fake_mise: two fake mise in two folders keep their own code" {
	sandbox
	fake_mise "$BATS_TEST_TMPDIR/other"
	fake mise 'echo first'
	run "$BATS_TEST_TMPDIR/other/mise" exec -- echo second
	[ "$output" = second ]
	run mise
	[ "$output" = first ]
}

@test "path_without: a fake that it relinks keeps its code" {
	sandbox
	fake alpha 'echo alpha'
	fake beta
	run env PATH="$(path_without beta)" bash -c alpha
	[ "$status" -eq 0 ]
	[ "$output" = alpha ]
}

@test "sandbox: a test cannot change a script of the repository" {
	sandbox ci-plan.sh
	[ -L scripts/ci-plan.sh ]
	run bash -c 'echo broken >scripts/ci-plan.sh'
	[ "$status" -ne 0 ]
	cmp -s "$ROOT/scripts/ci-plan.sh" "$(readlink scripts/ci-plan.sh)"
}

@test "skill_copy: a skill script runs from a read-only copy, once per suite" {
	dir=$(skill_copy decisionkit)
	[ "$dir" = "$BATS_FILE_TMPDIR/skills" ]
	cmp -s "$ROOT/.agents/skills/decisionkit/scripts/decide.sh" "$dir/decisionkit/scripts/decide.sh"
	run bash -c "echo broken >'$dir/decisionkit/scripts/decide.sh'"
	[ "$status" -ne 0 ]
	run bash -c "echo broken >'$dir/decisionkit/SKILL.md'"
	[ "$status" -ne 0 ]
	# A second call reuses the copy.
	touch "$dir/decisionkit/tests/marker"
	[ "$(skill_copy decisionkit)" = "$dir" ]
	[ -f "$dir/decisionkit/tests/marker" ]
}
