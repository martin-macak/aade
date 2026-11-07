---
name: pr-shepherd
description: >-
  Shepherds a pull request to merge in this repository. The PR body
  copies every "Done when" or "Acceptance criteria" item of its issue as
  an R item with evidence, and every review finding gets a triage as
  accepted or rejected. scripts/shepherd.sh checks the rules, decisionkit
  scores the carry-over, and the pr-shepherd CI job enforces them. Use
  this skill whenever you work on an open PR. That covers the
  Requirements and Verify sections, review comments and threads, any
  failing CI check of the PR, and the merge. Load it
  before you tick a PR task, reply to a review thread or run gh pr merge.
---

# PR shepherd

A pull request is ready to merge when it does what its issue asks and
shows proof for each item. Also, each review finding has an answer. This skill turns that into rules that a
script can check. The agent that works on a PR is its shepherd.

`scripts/shepherd.sh` does every step that must give the same result each
time. Run it from the repository root:

```sh
P=.agents/skills/pr-shepherd/scripts/shepherd.sh
mise exec -- $P check <pr>
```

`mise run pr:check <pr>` runs the same check, and `mise run pr:shepherd`
passes any command to the script. The `issue-authoring` skill covers the
title, the labels and how to open the PR.

## When to use

Use it for each PR that closes an issue, from the first push to the merge.
These PRs are exempt:

- **Dependabot PRs**, whose author is Dependabot, are exempt from every
  rule.
- **A PR with the label `pr:no-issue`** closes no issue. It doesn't need a
  Requirements section or a trace. Its checkboxes still need ticks and
  evidence, and its review findings still need triage.

A PR that has neither a `Closes #<issue>` line nor the label fails the
check.

## One pass

Each call of the script is idempotent. One pass runs these steps in order.
Run a new pass after each push and after each new review.

1. **Requirements.** Run `$P requirements <issue>` and paste its output as
   the `## Requirements` section. It copies each issue item as an R item.
2. **Work.** Do each R item. Split it into sub-tasks when it has more than
   one part. Tick an item only when it is done, and add its evidence.
3. **Verify.** Add V items for the checks that raise confidence: tests,
   CI runs, a dry run, a manual check.
4. **Findings.** Run `$P findings <pr>`. Triage each finding (see
   [Review triage](#review-triage)) and answer it with `$P reply`.
5. **Trace.** Run `$P verify <pr>`. Fix each `FAIL` row of the trace
   table, then run it again.
   Run it after the last push, because the trace belongs to the head
   commit.
6. **Check.** Run `$P check <pr>`. Fix each problem. Each line says how to
   fix it.
7. **Checks.** Run `$P checks <pr> --watch`. It waits for every other
   check of the PR, such as CI jobs, and lists each one that failed. Read
   the failed log, fix the cause, push, and start a new pass. Never
   re-run a failed check to hide a real failure. Re-run only a cancelled
   check, or a check that failed for a cause outside the PR, and state
   that cause in the `## Notes` section.
8. **Merge.** Run `$P merge <pr>`.

## PR body format

The PR template contains the sections. The check reads two of them:
`## Requirements` and `## Verify`. The body starts with `Closes #11`. The
Requirements section then looks like this:

```markdown
- [x] R1: skill is created
  - evidence: .agents/skills/pr-shepherd/SKILL.md
- [x] R2: skill is covered by tests
  - [x] R2.1: bats tests for the scripts
    - evidence: `make -C .agents/skills/pr-shepherd drift` -> 42/42 ok
```

The Verify section looks like this:

```markdown
- [x] V1 (R2): `mise run check` passes
  - evidence: https://github.com/martin-macak/aade/actions/runs/123
```

- **Closes line.** The body has a `Closes #<issue>` line. Without it, the
  PR needs the label `pr:no-issue`.
- **R items.** Write `R<n>: <text>` at the top level. The text equals the
  issue item, after white space is collapsed. The R items keep the issue
  order. The PR adds none and drops none. To change an item, edit the issue
  first.
- **Sub-tasks.** Write `R<n>.<m>: <text>`, indented below `R<n>`. You
  choose them. decisionkit checks that together they deliver the R item.
  Write each sub-task as a deliverable, such as a file, a command or a
  rule, not as agent behaviour. An evidence line can prove a deliverable,
  but it cannot prove a behaviour.
- **V items.** Write `V<n> (R<k>): <text>`. Name more R items with a comma:
  `V1 (R1, R3)`. The PR has at least one V item.
- **Ticks.** Every checkbox in the body is ticked before merge. The check
  ignores HTML comments and fenced code blocks, so examples do not count.

## Evidence

Each ticked leaf item in Requirements and Verify needs at least one
`evidence:` line below it. A leaf is an item without sub-tasks. Each
evidence line contains one of these:

- a repository path that the PR diff changes, or a folder with such a file;
- an `https://` URL, such as a CI run;
- `` `command` -> result ``, such as `` `bats tests` -> 31 ok ``.

The script checks the form of a line only. It does not run the command or
open the URL. decisionkit judges the content in the trace. A commit SHA is
never evidence. The push rules require squash and
`--force-with-lease`. Each rebase changes the SHAs.

## Trace

CI doesn't run an LLM, so it cannot ask decisionkit. `$P verify <pr>` asks for
it and leaves a trace that CI can read.

- For each R item, verify asks two questions of
  [references/questions.yml](references/questions.yml): `carryover` (do
  the sub-tasks deliver the issue item?) and `evidence` (does the evidence
  cover the item?).
- It upserts one PR comment with the marker `<!-- pr-shepherd-trace:v1 -->`.
  The comment has a table with the verdict and the probability of each
  answer.
- It sets the commit status `pr-shepherd/trace` on the head commit. The
  state is `failure` when an answer is false. The description holds
  `req=<hash> issue=<hash>`. Each hash is the first 8 hex digits of the
  SHA-256 of the Requirements section or of the issue items, with white
  space collapsed.
- It re-runs the newest `pr-shepherd` run of the head commit, because a
  new status fires no workflow.

The check fails when the head commit has no trace status, when the status
is not `success`, or when a hash differs. A new commit, an edit of the
Requirements section or an edit of the issue makes the trace stale, so run
verify again. Only users with write access can set a commit status, so a
fork cannot forge a trace.

Each cell of the table is `ok`, `uncertain` or `FAIL`, with the
probability of true. A `FAIL` cell is a false answer at the threshold of
the question. An `uncertain` cell is a true answer whose top probability
is below 0.8. It passes, and the status stays `success`. Then sharpen the
sub-tasks or the evidence and run verify again. If it stays uncertain,
decide yourself and state the reason in the `## Notes` section of the PR. Do not
present it as a decision of decisionkit.

## Review triage

Each review finding gets one of two verdicts:

- **accepted:** you fix it. In the reply, give the changed path or a
  short text for the fix, never a commit SHA.
- **rejected:** you do not fix it. The reply gives the reason.

`$P findings <pr>` prints each untriaged finding as one JSON line, with
its author, `bot` or `human`, and its text. A finding is from a `bot`
when GitHub marks its author as a bot account, or the login ends with
`[bot]`. The decisionkit answers of
`finding-valid` and `finding-severity` come with it as advice only, so
read the code before you decide.

**Authority rule.** You may reject a bot finding alone. Before you reject
a human finding, ask the user. Reject it only after the user agrees, and
pass `--confirmed-by-user`. A human reviewer is a person whom the user
trusts more than an agent.

Answer each finding with the script:

```sh
mise exec -- $P reply <pr> <thread-id> accepted --reason "<why>" --fix <path-or-text>
mise exec -- $P reply <pr> <review-id> rejected --reason "<why>" [--confirmed-by-user]
```

- `--fix` is required for `accepted`. The script writes the `triage:`,
  `reason:`, `fix:` and `confirmed-by-user: yes` lines itself.
- A thread ID starts with `PRRT_`. The reply goes into the thread with a
  `triage:` marker, and the script resolves the thread.
- A review ID is a number. It is for a finding in the body of a review,
  which has no thread. The body of an approving review doesn't need a triage. The reply is a PR comment with the lines
  `review: <id>` and `triage: <verdict>`.

The check fails when a thread is not resolved or has no triage reply,
when an accepted reply has no `fix:` line, or when a rejection of a human
finding has no `confirmed-by-user: yes`. It also fails while the latest review of any reviewer, bot or human,
requests changes. Then ask that reviewer to approve or
dismiss it.

## Merge

`$P merge <pr>` runs the check and the checks, and stops on a problem.
Then it reads the
ruleset rules of the base branch from
`repos/{owner}/{repo}/rules/branches/<base>`. It refuses auto-merge until the rules require the
`pr-shepherd` check, because GitHub could merge without that check. Only
an admin can change the ruleset, so ask the user. Then it runs
`gh pr merge --auto --rebase`, and GitHub merges when every required check
passes.

When someone edits an issue, the `disarm` job of the `pr-shepherd`
workflow turns off
auto-merge on each open PR that closes it. Run a new pass on such a PR.

## Script

```text
shepherd.sh requirements <issue>
shepherd.sh check <pr>
shepherd.sh verify <pr>
shepherd.sh findings <pr> [--no-advice]
shepherd.sh reply <pr> <thread-id|review-id> accepted|rejected --reason <text> [--fix <text>] [--confirmed-by-user]
shepherd.sh checks <pr> [--watch]
shepherd.sh merge <pr>
shepherd.sh disarm <issue>
```

Exit codes: `0` pass, `1` a rule fails, `2` wrong usage or a failed call.
The script reads one page of 100 review threads, reviews and thread
comments. It exits 2 when a PR has more. The check never passes on
findings that it did not read.
The script reads GitHub through `gh`, so it needs a logged-in `gh`.

The `pr-shepherd` workflow runs `mise run pr:check` on each PR event and
each review. Its job `pr-shepherd` is the check that the ruleset requires.

## Questions and calibration

`references/questions.yml` contains the four decisionkit questions:
`carryover`, `evidence`, `finding-valid` and `finding-severity`. The
script sends them through the facade of the `decisionkit` skill. Each
binary threshold sits in the middle of the gap that calibration printed.

Only the issue items, the R and sub-task texts, the evidence lines and the
review findings go to decisionkit, never the diff. A review finding can
quote code. Run `findings` with `--no-advice` when the code is not cleared
for the decisionkit provider.

Run `make -C .agents/skills/pr-shepherd calibrate` after each change to
a question or a threshold, and after a new decisionkit version. It scores the synthetic
fixtures in `tests/fixtures/calibration/<question>/<label>-*.txt`. Each
fixture must get its label.

## Tests

`make -C .agents/skills/pr-shepherd test` runs the layers of the
`knowledge-curator` skill and `calibrate`. Its drift layer runs these bats
files, without an LLM and without the network:

- `tests/shepherd.bats` runs `check` and `requirements` against the PR
  fixtures. A fake `gh` serves `tests/fixtures/prs/base`, a PR that
  passes. Each case folder in `good/` or `bad/` replaces a base file, or
  edits it with a `<file>.sed` or `<file>.jq`. Each bad case has an
  `expect.txt` with every problem line. For a new rule, add a bad case and
  write its `expect.txt` by hand.
- `tests/verify.bats` tests `verify`, `findings`, `reply`, `checks`,
  `merge` and `disarm` with a fake `gh` and a fake `decisionkit`.
- `tests/drift.bats` compares this file with the script, the questions,
  the PR template, the workflow, `labels.yml` and `mise.toml`.
