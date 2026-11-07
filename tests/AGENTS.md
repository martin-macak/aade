# tests/

The bats suites of the repository scripts. A suite stops a script from
breaking without notice, and it shows the intent and use cases of the
script. Skill scripts keep their suites in `tests/` of their skill.

## Rules

- Each `scripts/<x>.sh` has the suite `tests/scripts/<x>.bats`.
  `mise-tasks.bats` tests the inline bash of `mise.toml`, and `helpers.bats`
  tests `helpers/`. `mise run scripts:coverage` fails on a script without a
  suite, and on any other suite without a script.
- Start a suite with a short comment on what the script is for and why.
- Write one `@test` per use case and per exit path of the script. Phrase
  each test title as a rule, such as "check: reports drift, edits no file".
- Load `tests/scripts/helpers/common.bash`. Run each script in `sandbox`,
  a throwaway repository. A suite works only in its sandbox, offline.
- Fake each external tool with `tests/scripts/helpers/fakes.bash`, the one
  home of the fakes. Skill suites load it too. Extend a fake there, not in
  a suite, so every suite can reuse it.
- End a whole-line `[[ ]]`, `(( ))` or `! cmd` check with `|| false`, or
  use `has` and `lacks` of `common.bash`. bash 3.2 ignores such a failed
  check in the middle of a test, and `!` never fails a test.
  `scripts:coverage` fails on such a line.
- Keep each suite valid for bash 3.2 and BSD tools (macOS) and for bash 5
  and GNU tools (Linux), because developers and CI use both.
- `mise run scripts:test` runs every suite. The `scripts-test` pre-commit
  hook runs only the suites that a commit affects. The `scripts-test`
  workflow runs every suite on Linux and macOS when a file in `scripts/`
  or `tests/scripts/`, or `mise.toml`, changes.
