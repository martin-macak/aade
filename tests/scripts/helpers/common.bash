# Shared helpers for the suites in tests/scripts. Load with:
#   load helpers/common
# Each test runs a copy of a script in a throwaway repository, with the
# fake external tools of fakes.bash on PATH. No test reads or changes the
# real repository, and no test uses the network.

# The real repository root. A commit hook can export GIT_DIR, and git then
# reports the wrong root, so this does not ask git.
ROOT=$(cd "$BATS_TEST_DIRNAME/../.." && pwd)

# fake, fake_at, unfake, calls, path_without, suite_copy and the fakes of
# gh, decisionkit and mise.
source "${BASH_SOURCE[0]%/*}/fakes.bash"

# Create the repository $SANDBOX, link each named script of scripts/ into
# $SANDBOX/scripts/, and cd into $SANDBOX. The link points to a read-only
# copy of the script, made once per suite (suite_copy of fakes.bash), so a
# test cannot change the script of the repository. HOME and TMPDIR point into the
# test folder, so a script never sees the files of the user. The guard
# fakes of gh, decisionkit and claude go first on PATH, so a test that
# forgets a fake fails and never calls a real API.
sandbox() {
	unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_CONFIG_PARAMETERS
	# Credentials and settings of the caller must not reach a real tool.
	unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST GH_REPO XDG_CONFIG_HOME
	# A tool can pass git config through the environment, such as a
	# core.hooksPath. Drop it, so the sandbox has only its own config.
	# decisionkit and mise read settings from their own variables too.
	local var
	for var in $(env | sed -nE 's/^((GIT_CONFIG|DECISIONKIT|MISE)_[A-Za-z_0-9]*)=.*/\1/p'); do
		unset "$var"
	done
	guard_fakes
	SANDBOX="$BATS_TEST_TMPDIR/repo"
	export HOME="$BATS_TEST_TMPDIR/home" TMPDIR="$BATS_TEST_TMPDIR/tmp"
	export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
	mkdir -p "$SANDBOX/scripts" "$HOME" "$TMPDIR"
	# An empty template skips the sample hooks, so no test writes an
	# executable file.
	git init -q --template= "$SANDBOX"
	git -C "$SANDBOX" config user.name test
	git -C "$SANDBOX" config user.email test@example.com
	local script
	for script in "$@"; do
		ln -s "$(suite_copy "$ROOT/scripts/$script")" "$SANDBOX/scripts/$script"
	done
	cd "$SANDBOX" || return 1
}

# Write the file $1 below $SANDBOX with the content of stdin.
fixture() {
	mkdir -p "$(dirname "$SANDBOX/$1")"
	cat >"$SANDBOX/$1"
}

# Succeed when the text $1 holds the text $2, or lacks it. Use them in
# place of a bare [[ ]] in the middle of a test: bash 3.2 ignores a failing
# [[ ]] there, but a failing function call ends the test.
has() { [[ "$1" == *"$2"* ]]; }
lacks() { [[ "$1" != *"$2"* ]]; }
