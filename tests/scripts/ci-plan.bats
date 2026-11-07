#!/usr/bin/env bats

# scripts/ci-plan.sh decides what CI runs for a change, and `mise run test`
# uses it to run the affected bats suites. A wrong plan skips checks without
# a warning, so each rule has a test: the layers, the shared inputs that run
# every suite, the ci:full flag and the diff base. The sandbox holds a
# small repository with real copies of the two suite runners and a fake
# bats that records which suites would run.

bats_require_minimum_version 1.5.0

load helpers/common

setup() {
	sandbox ci-plan.sh script-tests.sh skill-drift.sh
	S=scripts/ci-plan.sh
	# One suite at a time, so the calls of the fake bats keep their order.
	export TEST_JOBS=1
	fake bats 'exit "${BATS_STATUS:-0}"'
	mkdir -p tests/scripts/helpers .agents/skills/alpha/tests
	touch scripts/alpha.sh tests/scripts/alpha.bats tests/scripts/mise-tasks.bats tests/scripts/helpers/common.bash
	echo '# alpha' >.agents/skills/alpha/SKILL.md
	touch .agents/skills/alpha/tests/drift.bats
	echo mise.toml >.agents/skills/alpha/tests/drift.watch
	printf '[tools]\njq = "1.8.2"\n\n[tasks.check]\nrun = "true"\n' >mise.toml
	echo '# Readme' >README.md
	git add -A
	git commit -qm base
	git branch -q base
}

# Print the value of the key $1 in $output.
value() {
	sed -n "s/^$1=//p" <<<"$output"
}

@test "usage: a missing or unknown mode, an unknown flag or a bad flag exits 2" {
	for args in "" "lint" "plan --nope" "test --full" "plan --base"; do
		run "$S" $args
		[ "$status" -eq 2 ]
		has "$output" "Usage: ci-plan.sh plan"
	done
}

@test "usage: outside the repository root it exits 2" {
	cd "$BATS_TEST_TMPDIR"
	run "$SANDBOX/$S" plan README.md
	[ "$status" -eq 2 ]
	[ "$output" = "Run ci-plan.sh from the repository root." ]
}

@test "plan: a changed script is repo layer and runs its suite" {
	run "$S" plan scripts/alpha.sh
	[ "$status" -eq 0 ]
	[ "$output" = "$(printf '%s\n' repo=true code=false full=false test=true)" ]
}

@test "plan: an unknown path is repo layer, so its checks never skip" {
	run "$S" plan some/new/place.txt
	[ "$(value repo)" = true ]
	[ "$(value code)" = false ]
	# It affects no suite, so only check runs.
	[ "$(value test)" = false ]
}

@test "plan: a code-only change runs no repo job" {
	# The code layer is empty until the monorepo exists. Add a path here.
	# The edited copy is not executable, so bash runs it: no test writes
	# an executable file.
	rm "$S"
	sed 's|^CODE_PATHS=()$|CODE_PATHS=(packages/)|' "$ROOT/scripts/ci-plan.sh" >"$S"
	run bash "$S" plan packages/app/index.ts packages/app/README.md
	[ "$output" = "$(printf '%s\n' repo=false code=true full=false test=false)" ]
	run bash "$S" plan packages/app/index.ts README.md
	[ "$(value repo)" = true ]
	[ "$(value code)" = true ]
}

@test "plan: a changed helper or the CI workflow runs every suite" {
	for file in tests/scripts/helpers/common.bash .github/workflows/ci.yml; do
		run "$S" plan "$file"
		[ "$(value full)" = true ]
		[ "$(value test)" = true ]
	done
}

@test "plan: a task edit in mise.toml runs only the suites that read mise.toml" {
	printf '\n[tasks.test]\nrun = "true"\n' >>mise.toml
	run "$S" plan mise.toml
	[ "$(value full)" = false ]
	[ "$(value test)" = true ]
	run "$S" test mise.toml
	[ "$status" -eq 0 ]
	[ "$(calls)" = "$(printf '%s\n' "bats tests/scripts/mise-tasks.bats" "bats .agents/skills/alpha/tests/drift.bats")" ]
}

@test "plan: a tool version edit in mise.toml runs every suite" {
	sed -i.bak 's/1.8.2/1.8.3/' mise.toml
	run "$S" plan mise.toml
	[ "$status" -eq 0 ]
	[ "$(value full)" = true ]
}

@test "plan --full: the ci:full label runs every suite" {
	run "$S" plan --full README.md
	[ "$(value full)" = true ]
	[ "$(value test)" = true ]
}

@test "plan --all: the weekly run sets every value" {
	run "$S" plan --all
	[ "$output" = "$(printf '%s\n' repo=true code=true full=true test=true)" ]
}

@test "plan: without files it reads the branch, the staged, unstaged and untracked files" {
	git checkout -qb work
	echo x >>scripts/alpha.sh
	git commit -qam work
	run "$S" plan --base base
	[ "$(value repo)" = true ]
	[ "$(value test)" = true ]
	git reset -q --hard base
	echo new >notes.txt
	run "$S" plan --base base
	[ "$(value repo)" = true ]
	[ "$(value test)" = false ]
}

@test "plan: a list that fails exits 2, and never plans test=false" {
	fake_at "$SANDBOX/scripts/skill-drift.sh" 'exit 2'
	run "$S" plan .agents/skills/alpha/SKILL.md
	[ "$status" -eq 2 ]
	has "$output" "ci-plan: cannot list the affected suites."
	lacks "$output" "test="
}

@test "plan: a failing first list fails the plan, even when the second list works" {
	# The skill list is not empty, so a lost failure would plan test=true.
	fake_at "$SANDBOX/scripts/script-tests.sh" 'exit 2'
	run "$S" plan .agents/skills/alpha/SKILL.md
	[ "$status" -eq 2 ]
	has "$output" "ci-plan: cannot list the affected suites."
	lacks "$output" "test="
}

@test "test: a list that fails exits 2, and runs no suite" {
	fake_at "$SANDBOX/scripts/skill-drift.sh" 'exit 2'
	run "$S" test .agents/skills/alpha/SKILL.md
	[ "$status" -eq 2 ]
	has "$output" "ci-plan: cannot list the affected suites."
	lacks "$(calls)" "bats "
}

@test "plan: a skill change runs its suite without bats on PATH" {
	unfake bats
	run env PATH="$(path_without bats)" "$S" plan .agents/skills/alpha/SKILL.md
	[ "$status" -eq 0 ]
	[ "$(value test)" = true ]
}

@test "plan: an empty change plans no job" {
	run "$S" plan --base base
	[ "$output" = "$(printf '%s\n' repo=false code=false full=false test=false)" ]
}

@test "plan: a base without a merge-base fails with exit 1" {
	run "$S" plan --base no-such-ref
	[ "$status" -eq 1 ]
	[ "$output" = "ci-plan: git found no merge-base of no-such-ref and HEAD." ]
}

@test "test: runs only the affected suites" {
	run "$S" test scripts/alpha.sh
	[ "$status" -eq 0 ]
	[ "$(calls)" = "bats tests/scripts/alpha.bats" ]
}

@test "test: without a repo-layer file runs nothing and passes" {
	run "$S" test --base base
	[ "$status" -eq 0 ]
	[ "$output" = "ci-plan: no repo-layer file changed, so no suite runs." ]
	[ -z "$(calls)" ]
}

@test "test --all: runs every suite in one parallel run" {
	run "$S" test --all
	[ "$status" -eq 0 ]
	has "$output" "ci-plan: every suite runs."
	[ "$(calls)" = "$(printf 'bats %s\n' tests/scripts/alpha.bats tests/scripts/mise-tasks.bats .agents/skills/alpha/tests/drift.bats)" ]
	[ "$(grep -c '^script-tests: ' <<<"$output")" -eq 1 ]
}

@test "test: a failing suite fails the run" {
	export BATS_STATUS=1
	run "$S" test scripts/alpha.sh
	[ "$status" -eq 1 ]
}
