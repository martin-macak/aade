#!/usr/bin/env bash

# Check that the agent environment of this machine works.
# Each check prints its problem to stderr and returns non-zero on failure.
# To add a check, define a function and add its name to CHECKS.

check_decisionkit_installed() {
	if ! command -v decisionkit >/dev/null 2>&1; then
		>&2 echo "decisionkit is not installed. Run 'mise install'."
		return 1
	fi
}

check_decisionkit_provider() {
	if [[ -z "${DECISIONKIT_PROVIDER:-}" ]]; then
		>&2 echo "DECISIONKIT_PROVIDER is not set. Set it in mise.local.toml. See README.md."
		return 1
	fi
}

check_decisionkit_status() {
	# Skip when decisionkit is missing. check_decisionkit_installed reports it.
	command -v decisionkit >/dev/null 2>&1 || return 0
	if ! decisionkit status >/dev/null 2>&1; then
		>&2 echo "decisionkit status failed. Run 'decisionkit status' for details."
		return 1
	fi
}

check_pre_commit_installed() {
	if ! grep -qs pre-commit "$(git rev-parse --git-path hooks)/pre-commit"; then
		>&2 echo "The pre-commit hook is not installed. Run 'mise run setup'."
		return 1
	fi
}

CHECKS=(
	check_decisionkit_installed
	check_decisionkit_provider
	check_decisionkit_status
	check_pre_commit_installed
)

HEALTHY=1
for check in "${CHECKS[@]}"; do
	"$check" || HEALTHY=0
done

if [[ $HEALTHY -eq 1 ]]; then
	echo "All checks passed. The agent environment is healthy."
else
	echo "Some checks failed. The agent environment is not healthy."
	exit 1
fi
