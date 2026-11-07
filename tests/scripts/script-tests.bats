#!/usr/bin/env bats

# scripts/script-tests.sh keeps the shell scripts tested. `run` picks the
# suites that a change can affect, so the pre-commit hook stays fast.
# `coverage` fails when a script has no suite, so a new script cannot slip
# in untested. `bats` runs suites in parallel and prints their output in
# order. A fake bats records which suites would run. Most tests run one
# suite at a time (TEST_JOBS=1), so the calls keep their order.

load helpers/common

setup() {
	sandbox script-tests.sh
	S=scripts/script-tests.sh
	export TEST_JOBS=1
	fake bats 'exit "${BATS_STATUS:-0}"'
	mkdir -p tests/scripts/helpers
	for name in alpha beta; do
		touch "scripts/$name.sh" "tests/scripts/$name.bats"
	done
	touch tests/scripts/mise-tasks.bats tests/scripts/script-tests.bats tests/scripts/helpers/common.bash
}

@test "usage: no mode, an unknown mode or extra coverage arguments exit 2" {
	for args in "" "lint" "coverage extra"; do
		run "$S" $args
		[ "$status" -eq 2 ]
		[[ "$output" == *"Usage: script-tests.sh run"* ]] || false
	done
}

@test "usage: outside the repository root it exits 2" {
	cd "$BATS_TEST_TMPDIR"
	run "$SANDBOX/$S" run
	[ "$status" -eq 2 ]
	[[ "$output" == *"Run script-tests.sh from the repository root."* ]] || false
}

@test "run: without files runs every suite in tests/scripts, one bats per suite" {
	run "$S" run
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(printf 'bats %s\n' tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats tests/scripts/script-tests.bats)" ]
}

@test "run: a changed script runs only its own suite" {
	run "$S" run scripts/alpha.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats tests/scripts/alpha.bats" ]
}

@test "run: a changed suite runs itself, once even when its script also changed" {
	run "$S" run tests/scripts/beta.bats scripts/beta.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats tests/scripts/beta.bats" ]
}

@test "run: a change to mise.toml runs mise-tasks.bats, which tests its inline tasks" {
	run "$S" run mise.toml
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats tests/scripts/mise-tasks.bats" ]
}

@test "run: a changed helper runs every suite" {
	run "$S" run scripts/alpha.sh tests/scripts/helpers/common.bash
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(printf 'bats %s\n' tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats tests/scripts/script-tests.bats)" ]
}

@test "run: files that affect no suite run nothing and pass" {
	touch scripts/orphan.sh
	run "$S" run README.md scripts/orphan.sh
	[ "$status" -eq 0 ]
	[ -z "$(calls)" ]
}

@test "run --list: prints the affected suites once each and runs nothing" {
	run "$S" run --list scripts/beta.sh tests/scripts/beta.bats scripts/alpha.sh
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' tests/scripts/alpha.bats tests/scripts/beta.bats)" ]
	[ -z "$(calls)" ]
}

@test "run --list: without files prints every suite" {
	run "$S" run --list
	[ "$status" -eq 0 ]
	[ "$(grep -c '' <<<"$output")" -eq 4 ]
	[ -z "$(calls)" ]
}

@test "run: a failing suite fails the run" {
	export BATS_STATUS=1
	run "$S" run scripts/alpha.sh
	[ "$status" -eq 1 ]
}

@test "bats: without suites exits 2" {
	run "$S" bats
	[ "$status" -eq 2 ]
	has "$output" "Usage: script-tests.sh run"
}

@test "bats: exits 2 and runs no suite when bats is missing" {
	unfake bats
	run env PATH="$(path_without bats)" "$S" bats tests/scripts/alpha.bats
	[ "$status" -eq 2 ]
	[ "$output" = "script-tests.sh needs bats on PATH. Run it through mise, such as: mise run scripts:test" ]
}

@test "bats: runs suites in parallel and prints each whole, in the given order" {
	export TEST_JOBS=3
	# The first suite waits until the last one has started, so it ends last.
	# A run one suite at a time would fail it, and a run that printed in end
	# order would print it last.
	fake bats '
case $1 in
*alpha*)
	n=0
	while [ ! -f "$FAKE_DIR/mise-started" ] && [ "$n" -lt 100 ]; do
		sleep 0.1
		n=$((n + 1))
	done
	[ -f "$FAKE_DIR/mise-started" ] || exit 1
	;;
*mise*) touch "$FAKE_DIR/mise-started" ;;
esac
printf "1..1\nok 1 %s\n" "$1"'
	run "$S" bats tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '==> %s\n1..1\nok 1 %s\n' tests/scripts/alpha.bats tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats tests/scripts/mise-tasks.bats)
script-tests: 3 suites passed." ]
}

@test "bats: starts the biggest suite first, and keeps the given order in the output" {
	printf '%s\n' one two three >tests/scripts/beta.bats
	fake bats 'echo "ran $1"'
	run "$S" bats tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(printf 'bats %s\n' tests/scripts/beta.bats tests/scripts/alpha.bats tests/scripts/mise-tasks.bats)" ]
	[ "$output" = "$(printf '==> %s\nran %s\n' tests/scripts/alpha.bats tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats tests/scripts/mise-tasks.bats)
script-tests: 3 suites passed." ]
}

@test "bats: runs every suite, fails, and names each failed suite at the end" {
	export TEST_JOBS=2
	fake bats 'echo "not ok 1 $1"; case $1 in *beta* | *mise*) exit 1 ;; esac'
	run "$S" bats tests/scripts/alpha.bats tests/scripts/beta.bats tests/scripts/mise-tasks.bats
	[ "$status" -eq 1 ]
	[ "${lines[${#lines[@]} - 1]}" = "script-tests: 2 of 3 suites failed: tests/scripts/beta.bats tests/scripts/mise-tasks.bats" ]
	[ "$(calls | wc -l | tr -d ' ')" -eq 3 ]
}

@test "coverage: passes when each script has a suite and each suite a script" {
	mkdir -p .agents/skills/demo/scripts .agents/skills/demo/tests
	touch .agents/skills/demo/scripts/tool.sh .agents/skills/demo/tests/tool.bats
	# A skill may keep suites without a script, such as drift tests.
	touch .agents/skills/demo/tests/drift.bats
	touch scripts/script-tests.sh
	run "$S" coverage
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "coverage: a repository script without a suite fails" {
	touch scripts/gamma.sh
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = "scripts/gamma.sh has no suite. Add tests/scripts/gamma.bats." ]
}

@test "coverage: a skill script without a suite in its skill fails" {
	mkdir -p .agents/skills/demo/scripts
	touch .agents/skills/demo/scripts/tool.sh
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = ".agents/skills/demo/scripts/tool.sh has no suite. Add .agents/skills/demo/tests/tool.bats." ]
}

@test "coverage: a suite in tests/scripts without its script fails" {
	touch tests/scripts/stale.bats
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = "tests/scripts/stale.bats tests no script. scripts/stale.sh is missing." ]
}

@test "coverage: mise-tasks.bats needs no script, because it tests mise.toml" {
	run "$S" coverage
	[ "$status" -eq 0 ]
}

@test "coverage: helpers.bats needs no script, because it tests the helpers" {
	touch tests/scripts/helpers.bats
	run "$S" coverage
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "coverage: reports every problem, not only the first" {
	touch scripts/gamma.sh tests/scripts/stale.bats
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$(grep -c '' <<<"$output")" -eq 2 ]
}

# A test file for the silent-check rule: one line per check form.
silent() {
	mkdir -p tests/scripts
	printf '@test "t" {\n\t%s\n\ttrue\n}\n' "$1" >tests/scripts/alpha.bats
}

@test "coverage: a whole-line [[ ]] check fails, because bash 3.2 ignores it" {
	silent '[[ "$output" == *x* ]]'
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
}

@test "coverage: a whole-line (( )) check fails, with or without spaces" {
	for check in '(( 1 > 2 ))' '((1 > 2))'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 1 ]
	done
}

@test "coverage: a line that starts with ! fails, because ! never fails a test" {
	silent '! grep -q x file'
	run "$S" coverage
	[ "$status" -eq 1 ]
}

@test "coverage: the same checks with || false pass" {
	for check in '[[ a == b ]] || false' '((1 > 2)) || false' '! grep -q x file || false'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 0 ]
	done
}

@test "coverage: a condition with && or then is control flow and passes" {
	for check in '[[ -f x ]] && rm x' 'if [[ -f x ]]; then rm x; fi' 'n=$((n + 1))'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 0 ]
	done
}

@test "coverage: a trailing ; or # comment does not hide a check" {
	for check in '[[ a == b ]];' '[[ a == b ]] # why' '((1 > 2)) ;' '! grep -q x file # why'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 1 ]
		[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
	done
}

@test "coverage: a [[ ]] check over several lines fails, at its first line" {
	silent $'[[ a == b &&\n\tc == d ]]'
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
}

@test "coverage: a chain of tests joined by && fails, because only its last test counts" {
	for check in '[ a = b ] && [ c = d ]' '[ -f x ] && [[ y == z ]]' 'test -f x && test -f y'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 1 ]
		[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
	done
}

@test "coverage: ! cmd || <x> fails unless <x> ends the test" {
	silent '! grep -q x file || true'
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
	for end in false 'return 1' 'exit 1' 'fail "x"' '{ echo x; return 1; }'; do
		silent "! grep -q x file || $end"
		run "$S" coverage
		[ "$status" -eq 0 ]
	done
}

@test "coverage: an arithmetic statement fails, with advice to assign" {
	for check in '((i++))' '((n += 2))' '((--n))' '((x = 1))'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 1 ]
		[ "$output" = "tests/scripts/alpha.bats:2: this (( )) statement fails a test when its value is 0. Write an assignment, such as n=\$((n + 1))." ]
	done
}

@test "coverage: a comparison in (( )) is a check, not an arithmetic statement" {
	for check in '((a == b))' '((a <= b))' '((a >= b))' '((a != b))'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 1 ]
		[ "$output" = "tests/scripts/alpha.bats:2: this check cannot fail a test. Add || false." ]
	done
}

@test "coverage: control flow and checks that end the test pass" {
	for check in '[[ a == b ]] || false # why' '[ -f x ] && rm x' '[ a = b ] && [ c = d ] || false' 'echo "# [[ x ]]"' '[ "$status" -eq 0 ]'; do
		silent "$check"
		run "$S" coverage
		[ "$status" -eq 0 ]
	done
}

@test "coverage: a test that makes a file executable fails" {
	for mode in "+x" "u+x" "a=rwx" "755" "0700" "-R 711"; do
		printf '@test "t" {\n\tchmod %s file\n}\n' "$mode" >tests/scripts/alpha.bats
		run "$S" coverage
		[ "$status" -eq 1 ]
		has "$output" "tests/scripts/alpha.bats:2: this test makes a file executable."
	done
	mkdir -p .agents/skills/demo/tests
	printf '@test "t" {\n\tchmod +x file\n}\n' >.agents/skills/demo/tests/x.bats
	printf '@test "t" {\n\ttrue\n}\n' >tests/scripts/alpha.bats
	run "$S" coverage
	[ "$status" -eq 1 ]
	has "$output" ".agents/skills/demo/tests/x.bats:2: this test makes a file executable."
}

@test "coverage: chmod without an execute bit, a comment and the helpers pass" {
	# The mode is a variable, so this file does not trip the rule itself.
	x=+x
	printf '@test "t" {\n\tchmod a-w file\n\tchmod 644 file\n\t# chmod %s is not allowed\n}\n' "$x" >tests/scripts/alpha.bats
	echo "chmod $x \"\$1\"" >tests/scripts/helpers/common.bash
	run "$S" coverage
	[ "$status" -eq 0 ]
	[ -z "$output" ]
}

@test "coverage: the silent-check rule also reads skill tests and helpers" {
	mkdir -p .agents/skills/demo/tests/helpers
	echo '[[ a == b ]]' >.agents/skills/demo/tests/drift.bats
	echo '! true' >.agents/skills/demo/tests/helpers/stub
	echo '((1 > 2))' >tests/scripts/helpers/common.bash
	run "$S" coverage
	[ "$status" -eq 1 ]
	[ "$(grep -c 'cannot fail' <<<"$output")" -eq 3 ]
}
