# tests/

The bats suites of the repository scripts. A suite stops a script from
breaking without notice, and it shows the intent and use cases of the
script. Skill scripts keep their suites in `tests/` of their skill.

## Rules

- Each `scripts/<x>.sh` has the suite `tests/scripts/<x>.bats`. The suite
  `tests/scripts/mise-tasks.bats` tests the inline bash of `mise.toml`.
  `scripts:coverage` fails on a script without a suite, and on a suite
  without a script.
- Start a suite with a short comment on what the script is for and why.
- Write one `@test` per use case and per exit path of the script. Phrase
  each test title as a rule, such as "check: reports drift, edits no file".
- Load `tests/scripts/helpers/common.bash`, and run each script offline
  in `sandbox`: a throwaway repository with a link to a read-only copy of
  the script. Fake each external tool in
  `tests/scripts/helpers/fakes.bash`, which skill suites load too. Extend
  a fake there, not in a suite, so every suite can reuse it.
- Never write an executable file in a test: macOS can scan each new one
  for 0.2 s on its first run. A fake links to one stub, and an edited
  script runs with `bash`. `scripts:coverage` rejects `chmod +x`.
- End a whole-line `[[ ]]`, `(( ))` or `! cmd` check with `|| false`, or
  use `has` and `lacks` of `common.bash`: bash 3.2 ignores such a failed
  check mid-test, `!` never fails one, and `scripts:coverage` rejects it.
- Keep each suite valid for bash 3.2 and BSD tools (macOS) and for bash 5
  and GNU tools (Linux), because developers and CI use both.
- `mise run test` and the `test` hook run the affected suites in parallel,
  one per CPU (`--all`: every suite). CI runs them on Linux and macOS.
