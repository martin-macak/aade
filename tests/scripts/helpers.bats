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
