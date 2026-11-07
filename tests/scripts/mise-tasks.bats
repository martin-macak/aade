#!/usr/bin/env bats

# Two tasks of mise.toml hold inline bash: skills:test loops over the
# skills, and issue:new turns the mise arguments into the arguments of
# scripts/issue-new.sh. The suite copies only these tasks into a sandbox
# mise.toml without [tools], so mise installs nothing, and runs them with
# the real mise. Fake make and a fake issue-new.sh record the calls.

load helpers/common

setup() {
	# Fail, not skip: a skipped suite looks like a passed one in CI.
	MISE=$(command -v mise) || {
		echo "mise-tasks.bats needs mise on PATH."
		return 1
	}
	YQ=$(command -v yq) || {
		echo "mise-tasks.bats needs yq on PATH."
		return 1
	}
	sandbox
	"$YQ" -p toml -o toml '{"tasks": {"skills:test": .tasks["skills:test"], "issue:new": .tasks["issue:new"]}}' \
		"$ROOT/mise.toml" >mise.toml
	export MISE_TRUSTED_CONFIG_PATHS=$SANDBOX MISE_YES=1
	fake make '[[ " $* " == *" .agents/skills/${MAKE_FAILS:-none}/ "* ]] && exit 1; exit 0'
	mkdir -p .agents/skills/alpha .agents/skills/beta
	cat >scripts/issue-new.sh <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "issue-new.sh $*" >>"$FAKE_LOG"
printf 'stdin: %s\n' "$(cat)" >>"$FAKE_LOG"
exit "${ISSUE_STATUS:-0}"
FAKE
	chmod +x scripts/issue-new.sh
}

# Run the task $1 with the arguments that follow.
task() {
	run "$MISE" run -q "$@"
}

@test "skills:test without a skill runs make test in every skill folder" {
	task skills:test
	[ "$status" -eq 0 ]
	[ "$(calls)" = "make -k -C .agents/skills/alpha/ test
make -k -C .agents/skills/beta/ test" ]
}

@test "skills:test with a skill runs only that skill" {
	task skills:test beta
	[ "$status" -eq 0 ]
	[ "$(calls)" = "make -k -C .agents/skills/beta/ test" ]
}

@test "skills:test keeps going after a failing skill, then fails" {
	export MAKE_FAILS=alpha
	task skills:test
	[ "$status" -ne 0 ]
	[ "$(grep -c '^make ' <<<"$(calls)")" -eq 2 ]
}

@test "issue:new passes the type and stdin to issue-new.sh" {
	run "$MISE" run -q issue:new chore <<<"title: t"
	[ "$status" -eq 0 ]
	[ "$(calls)" = "issue-new.sh chore
stdin: title: t" ]
}

@test "issue:new --dry-run adds --dry-run after the type" {
	run "$MISE" run -q issue:new chore --dry-run <<<"title: t"
	[ "$status" -eq 0 ]
	grep -qx 'issue-new.sh chore --dry-run' <<<"$(calls)"
}

@test "issue:new returns the exit code of issue-new.sh" {
	export ISSUE_STATUS=2
	run "$MISE" run -q issue:new chore <<<"title: t"
	[ "$status" -eq 2 ]
}

@test "issue:new without a type fails before it runs the script" {
	task issue:new </dev/null
	[ "$status" -ne 0 ]
	[ -z "$(calls)" ]
}
