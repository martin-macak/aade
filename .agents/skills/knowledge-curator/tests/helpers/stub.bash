# Fake commands for the test-skill.sh tests. Load it, then call
# stub_command <name> in setup.
#
#   <name>.log        One line per call in $BATS_TEST_TMPDIR: the arguments,
#                     each shell-quoted and followed by a space.
#   <name>.responder  Optional file in $BATS_TEST_TMPDIR. The fake sources it
#                     with the call's arguments and stdin. It prints the
#                     output and ends with "exit <code>". Without it, the
#                     fake exits 0.

stub_command() {
	mkdir -p "$BATS_TEST_TMPDIR/bin"
	# The unquoted heredoc fixes the paths now. \$ keeps a value for run time.
	cat >"$BATS_TEST_TMPDIR/bin/$1" <<STUB
#!/usr/bin/env bash
{
	printf '%q ' "\$@"
	printf '\n'
} >>"$BATS_TEST_TMPDIR/$1.log"
if [[ -f "$BATS_TEST_TMPDIR/$1.responder" ]]; then
	source "$BATS_TEST_TMPDIR/$1.responder" "\$@"
	exit \$?
fi
exit 0
STUB
	chmod +x "$BATS_TEST_TMPDIR/bin/$1"
	PATH="$BATS_TEST_TMPDIR/bin:$PATH"
}

# Write the responder of a fake command from stdin.
responder() {
	cat >"$BATS_TEST_TMPDIR/$1.responder"
}
