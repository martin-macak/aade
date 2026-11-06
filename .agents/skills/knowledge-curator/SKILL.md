---
name: knowledge-curator
description: >-
  Covers the knowledge layer of this repository: where every rule, fact and
  procedure lives (root and nested AGENTS.md, skills, references, README,
  docs/, the ledger), how a new instruction is triaged and scored with
  decisionkit, how skills are written and tested, and how the layer is
  audited and linted. Use this skill whenever you add, move or edit an
  instruction, a rule, a constitution entry, a nested AGENTS.md, a skill or
  a doc page, even a one-line change, and whenever the user asks to review,
  audit, clean up or reorganise instructions, skills or documentation. Load
  it before you decide yourself where a new instruction or fact belongs.
---

# Knowledge curator

`AGENTS.md` files, the skills in `.agents/skills` and the human docs store
every rule of this repository. Each rule is stored in exactly one of them.
Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot and humans read the
same files. `docs/agentic-setup.md` explains how each agent finds them.

## Principles

- **One home per fact.** Every other place links to that home. Copies
  drift apart and then contradict each other.
- **No inventory in prose.** An instruction file, skill or doc never
  lists files, classes, functions or other members of the code. Refer to
  a folder pattern, such as `<module>/`, as the logical unit. Describe
  each interface in the doc comment of the code. A list goes stale with
  the next change to the code.
- **The root AGENTS.md is expensive.** Every line costs context in every
  task of every agent. It contains only the constitution and guardrails.
- **Guardrails stay always on.** A skill or a nested `AGENTS.md` loads
  only when an agent recognises its task or works in its folder. Any rule
  that prevents costly or irreversible damage cannot wait for that, so it
  stays in the root `AGENTS.md`.
- **Every rule states its reason.** A rule with its reason still applies
  to cases that the rule does not name.
- **Verify before you write.** A fact enters a rule only after you checked
  it in current docs (see the `library-docs` skill) or tested it.
- **Mark your own calls.** When an agent adds a rule that the user did not
  ask for, it says so to the user, who confirms or rejects it.

## Knowledge map

| Home | Holds | Audience |
| --- | --- | --- |
| `AGENTS.md` | The constitution and guardrails. At most 50 lines. | All agents, always loaded |
| `<folder>/AGENTS.md` | Purpose, intent and local rules of one folder. At most 30 lines. | Agents that work in that folder |
| `.agents/skills/<name>/SKILL.md` | Rules and procedures for one domain. At most 500 lines. | Agents, loaded on demand |
| `<skill>/references/` | Long material, templates, registers such as the ledger. | Agents, when the skill points there |
| `<skill>/scripts/` | Deterministic checks and tools. | Agents, hooks and CI |
| `<skill>/tests/` | The skill tests and their cases. | Agents, hooks and CI |
| `<skill>/Makefile` | The `test` target for the skill tests. | Everyone |
| `README.md` | Repository summary and setup. | Humans |
| `docs/` | Longer human docs, such as the agent setup. | Humans |
| Config file comments | Why one setting exists. | Everyone who edits it |
| `CLAUDE.md`, `GEMINI.md` | Symlinks to an `AGENTS.md`. Never edit or replace them. | Claude Code, Gemini CLI |

Human docs link to skills instead of copying them. Skills are plain
Markdown, so people can read them too.

**Add a home only through triage.** When the stack arrives, new homes such
as doc comments, API descriptions or decision records may be needed. Add a
row here in the same change that creates the first file of the new home,
and tell the user. A home without a row is a fact without an owner.

**Nested AGENTS.md.** Create one when a folder has a purpose or local rules
that only work inside it needs. Then run `mise run agents:link`, which adds
the `CLAUDE.md` and `GEMINI.md` symlinks in the same folder. Agents load
nested files in different ways. Some load them only when they work in that folder. A
guardrail always goes in the root `AGENTS.md` too, for this reason.

Current skills:

| Skill | Domain |
| --- | --- |
| `knowledge-curator` | This skill: the knowledge layer itself. |
| `decisionkit` | Closed decisions with calibrated probabilities. |
| `cold-reader` | Documentation quality through Vale, a cold reader and decisionkit. |
| `library-docs` | Current library docs through Context7. |
| `issue-authoring` | GitHub issues, pull requests and the label taxonomy in `.github/`. |

## Triage a new instruction

Before you add an instruction to any file, triage it. Load the
`decisionkit` skill first. Ask three questions:

```sh
Q_CLASS="Classify this instruction from a repository's root AGENTS.md \
(shared by Claude Code, Codex, Cursor, Gemini CLI and GitHub Copilot). \
'general' means nearly every agent task in this repo needs it, so it must \
stay in AGENTS.md. 'skill' means only specific kinds of tasks need it, so \
it belongs in an on-demand skill or a nested AGENTS.md that loads when \
relevant."
Q_FREQ="How often does an agent working in this repository need this \
instruction across all its tasks?"
Q_IMPACT="Skills load only when an agent recognises a matching task. If an \
agent missed this instruction because the skill holding it did not load, \
how costly or hard to reverse would the result be?"

decisionkit choice "$Q_CLASS" general skill --context "<instruction>"
decisionkit score "$Q_FREQ" rarely sometimes often always --context "<instruction>"
decisionkit score "$Q_IMPACT" low medium high --context "<instruction>"
```

Use the **expected values** of the two scores, not only the top label.
The expected value uses the whole probability distribution, so it weighs
the evidence. Frequency runs from 0 (rarely) to 3 (always). Impact runs
from 0 (low) to 2 (high).

**Score the exact wording you will commit.** Repeated runs agree within
about 0.02, but a reworded rule can score very differently. If you change
the wording after triage, triage again.

Then apply the first rule that matches:

1. **The user placed it in `AGENTS.md` by name.** Keep one line there. Put
   the details in a skill and point to it. A direct instruction overrides
   any score.
2. **Guardrail: impact ≥ 1.5.** One line in `AGENTS.md`.
3. **General: class `general` with p ≥ 0.8 and frequency ≥ 1.5.** Put it
   in `AGENTS.md`, as short as possible.
4. **Skill: class `skill` with p ≥ 0.8.** Put it in a skill, or in the
   nested `AGENTS.md` of the one folder it is about. Pick the skill with
   `decisionkit choice "Which skill should hold this instruction?" <skill
   names> new-skill`, and give each option's domain in the question.
5. **Otherwise the result is uncertain.** Decide yourself. Use
   frequency: ≥ 1.5 stays in `AGENTS.md`, below moves to a skill. State
   the reason.

An exception to these rules is fine when it doesn't add a line to
`AGENTS.md`. Example: fold a rare but risky detail into an existing
`AGENTS.md` sentence instead of moving it to a skill. Record the reason in
the ledger.

Every placement decision for the root `AGENTS.md` goes into the ledger:
[references/agents-md-ledger.md](references/agents-md-ledger.md). Report
the triage to the user: instruction, class with probability, both
expected values, the rule that applied, and your decision.

## Write a skill

1. Create `.agents/skills/<name>/SKILL.md`. The YAML front matter needs
   `name` (equal to the folder name) and `description`.
2. Write the description for triggering. It decides when an agent loads
   the skill. State the domain, the files and the tasks that need it. Be a
   little pushy, because agents tend to skip skills.
3. Do not link it. `.claude/skills` is a symlink to the whole
   `.agents/skills` folder, and the other agents read `.agents/skills`
   directly.
4. Pick a name that does not collide with common global skills, such as
   `code-review` or `context7-mcp`.
5. Keep `SKILL.md` under 500 lines. Move long material to `references/`
   and checks to `scripts/`. Link them from `SKILL.md` and say when to
   read them.
6. Add the skill to the "Current skills" table above.
7. Add its tests. See [Test a skill](#test-a-skill).

Edit `AGENTS.md`, never `CLAUDE.md` or `GEMINI.md`. Writing through a
symlink can replace it with a regular file. Never create
`.github/copilot-instructions.md`. Copilot reads `AGENTS.md` natively, so
that file would load the rules twice.

## Test a skill

Each skill has tests, so a skill that goes stale fails before it misleads
an agent. Run them before you commit a change to a skill:

```sh
make -C .agents/skills/<name> test   # one skill, every layer
mise run skills:test                 # every skill, every layer
mise run skills:drift                # every skill, drift layer only
```

The skill folder holds a `Makefile` with the line
`include ../knowledge-curator/scripts/skill.mk`, and a `tests/` folder.
[`scripts/test-skill.sh`](scripts/test-skill.sh) runs four layers:

| Layer | It fails when | Input | Tools |
| --- | --- | --- | --- |
| `drift` | A fact in the skill no longer matches the repository. | `tests/*.bats`, `tests/*.watch` | bats |
| `triggers` | The description loads the skill for a task of another skill, or not for its own task. | `tests/triggers.txt` | Claude headless |
| `knowledge` | A cold reader cannot learn a key rule from `SKILL.md` alone. | `tests/knowledge.txt` | Claude headless, decisionkit |
| `slop` | A `##` section of `SKILL.md` scores `SLOP_MAX` or more. | `SKILL.md` | decisionkit |

- **drift** also runs in the pre-commit hook `skill-drift` and in CI. Use
  only bash, git, grep, awk, yq and jq, because CI has no other tools. Find
  the repository root with `cd "$BATS_TEST_DIRNAME/../../../.." && pwd`,
  not with git. A commit hook can export `GIT_DIR`, and git then reports
  the wrong root. A test that creates a throwaway repository must unset
  `GIT_DIR` first. Test the facts that go stale: tables of hooks, tasks
  and skills, limits, versions and paths. A test file lists each path
  outside the skill that it reads in a `.watch` file with the same name,
  one per line, such as `tests/drift.watch` for `tests/drift.bats`. A path
  that ends with `/` covers a folder. The hook runs a test file only when a
  commit changes its skill folder or a watched path. A drift test checks
  that each `.watch` file lists the outside paths of its test file, and
  that the `files` filter of the hook lists every watched path. On a
  mismatch, it prints the filter to paste.
- **triggers** has one task per line. A `+ <task>` line must load the
  skill. A `- <task>` line must not. Write each `-` task so that it clearly
  belongs to another skill. The run offers only the `Skill` tool, so the
  agent must pick a skill or answer. The layer measures how well the
  descriptions tell the skills apart, not how often a real session loads
  them. Each task runs 3 times, and the majority decides. The layer uses
  Claude Code, but the descriptions serve every agent.
- **knowledge** has blocks of one `Q: <question>` line and one
  `A: <expected answer>` line. The cold reader sees only `SKILL.md`, so ask
  about rules in `SKILL.md`, not in `references/`. Write each expected
  answer as a full sentence, because a fragment scores low even against a
  right answer. decisionkit grades each answer with `Q_KNOW`. An answer
  passes when its probability is `KNOW_MIN` or more.
- **slop** scores each section with `Q_SLOP` and `SLOP_MAX` from the
  `cold-reader` skill. A score below `SLOP_MAX`, but by less than 0.1,
  prints `WARN`.

The `knowledge-lint` hook requires a `Makefile`, a `tests/*.bats` file, at
least 3 `+` and 3 `-` tasks, and at least 3 questions in each skill. Only
`make` runs the LLM layers, because no LLM runs in hooks or CI. The
environment variables `SKILL_TEST_MODEL` (default `haiku`),
`SKILL_TEST_RUNS` (default 3) and `SKILL_TEST_JOBS` (default 4) change a
run. Add `-k` to the `make` command to run every layer after a failure.

A skill may add a layer of its own as a target in its `Makefile`, and
`test` then runs it too. `knowledge-curator` and `cold-reader` add
`calibrate`, which scores their grader fixtures with decisionkit.

### Knowledge grading

`scripts/test-skill.sh` reads this block. Do not rename the fence.

```sh skill-tests
Q_KNOW="Text A is the expected answer to a question about a document. Text \
B is a reader's answer to the same question, written from the document \
alone. Does B state every fact of A, with no fact that contradicts A? Extra \
facts in B that do not contradict A are fine. Judge the facts, values, \
paths, commands and conditions, not the wording."
KNOW_MIN=0.5
```

`KNOW_MIN` comes from calibration with decisionkit 0.4.0 and the Jev
provider. Right answers scored 0.84 or more, and wrong answers scored 0.08
or less. Scores drift by up to 0.1, so `KNOW_MIN` sits in the middle of the
gap. After you change `Q_KNOW` or the decisionkit version, run
`make -C .agents/skills/knowledge-curator calibrate`. It scores the pairs in
[`tests/fixtures/knowledge/`](tests/fixtures/knowledge/). Each `same-*` pair
must pass, and each `differ-*` pair must fail.

## Audit the knowledge layer

Audit when the user asks, or after a change that adds a skill, moves a
rule to another home, or changes more than one rule of the root
`AGENTS.md`. Report each finding with its evidence, and let the user
decide each one, because an audit can remove rules that someone needs.

1. Run `mise run check`. It runs the deterministic checks of CI.
2. Run `mise run skills:test` for the skills that the change touched.
3. Compare the root `AGENTS.md` with the ledger. Each rule has one active
   row with the triage of its exact wording.
4. Look for one fact in two homes. Look also for a rule without a reason
   and for inventory in prose.
5. Check each nested `AGENTS.md` against its folder. Its purpose still
   matches. Each guardrail in it is also in the root.

## Enforcement

Five pre-commit hooks guard the layer. CI runs the same checks with
`mise run check`. They check structure and stale facts only. Triage and
placement stay your job.

- **`agents-check`** runs `mise run agents:check`. It fails when a
  `CLAUDE.md` or `GEMINI.md` is not a symlink to the `AGENTS.md` beside it,
  or when a generated agent config is out of date.
- **`agents-md-size`** runs `scripts/check-agents-md-size.sh`. It fails
  when the root `AGENTS.md` exceeds `MAX_LINES` (50 today), or a nested
  `AGENTS.md` exceeds `MAX_NESTED_LINES` (30 today). Do not raise a limit
  to make a change fit, because every line costs context in every task of
  every agent (see [Principles](#principles)). Move content into a skill.
- **`knowledge-lint`** runs `scripts/lint-knowledge.sh`. It checks that:
  - each skill folder in `.agents/skills` has a `SKILL.md` with a
    matching `name` and a `description`, at most 500 lines;
  - each skill has the tests that [Test a skill](#test-a-skill) requires;
  - relative links in every Markdown file resolve;
  - a commit that adds or changes a line of the root `AGENTS.md` also
    stages the ledger.
- **`skill-drift`** runs each skill test file that a commit affects. See
  [Test a skill](#test-a-skill).
- **`vale`** lints the prose of each Markdown file. The `cold-reader`
  skill explains its rules.
