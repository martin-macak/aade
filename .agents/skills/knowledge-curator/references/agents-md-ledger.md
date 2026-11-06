# AGENTS.md ledger

One row per rule in the root `AGENTS.md`. Each row records the decisionkit
triage of the exact committed wording and the matrix rule that placed it.
The `knowledge-lint` hook fails a commit that adds or changes a line of the
root `AGENTS.md` without staging this file.

- **Class:** the winning label of `Q_CLASS` and its probability.
- **Freq:** expected value of `Q_FREQ`, from 0 (rarely) to 3 (always).
- **Impact:** expected value of `Q_IMPACT`, from 0 (low) to 2 (high).
- **Rule:** the matrix rule in `SKILL.md` that applied (1 to 5).

The questions are in [../SKILL.md](../SKILL.md). Scores come from
decisionkit 0.4.0 with the Jev provider.

## Active rules

| ID | Rule (short) | Class | Freq | Impact | Rule | Decision and reason | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Intro: the `CLAUDE.md` and `GEMINI.md` symlinks point here, so edit only `AGENTS.md`. Nested files add folder rules. Direct instructions win. | general 0.96 | 2.41 | 0.58 | 3 | Keep. Absorbs C1 at no new line. The `.github/copilot-instructions.md` link was removed, because Copilot reads `AGENTS.md` natively and loaded the rules twice. | 2026-11-06 |
| C2 | Keep this file small. Load `knowledge-curator` before you change any instruction, skill or doc. | general 0.70 | 2.59 | 0.94 | 5 | Keep. Uncertain class, but frequent. The user asked that knowledge-curator decide where knowledge goes. | 2026-11-06 |
| C3 | Skills in `.agents/skills/` hold task rules. Load the matching skill first. | general 0.85 | 2.53 | 0.85 | 3 | Keep. The bridge to every skill. | 2026-11-06 |
| C4 | Use decisionkit for closed decisions. Load its skill first. | skill 0.98 | 1.14 | 0.70 | 1 | Keep one line. The user placed it in the constitution of spring-ref-arch by name, and asked for decisions to work the same way here. The user confirmed it on 2026-11-06. Details in `decisionkit`. | 2026-11-06 |
| C5 | Pin every tool in `mise.toml`. Run tools and checks through mise. | general 0.93 | 2.20 | 1.09 | 3 | Keep. | 2026-11-06 |
| C6 | Pre-commit is the gate. Never `--no-verify`. | general 0.88 | 1.87 | 0.65 | 3 | Keep. | 2026-11-06 |
| C7 | Secrets, credentials, personal data out of commits, MCP config and external services. | general 0.98 | 2.54 | 1.78 | 2 | Keep. Guardrail. | 2026-11-06 |
| V1 | Conventional Commits. | general 0.55 | 2.01 | 0.21 | 5 | Keep. Uncertain class, but frequent. | 2026-11-06 |
| V2 | Linear history. Rebase, do not merge. | general 0.65 | 2.15 | 1.17 | 5 | Keep. Uncertain class, but frequent. | 2026-11-06 |
| V3 | Write prose in short, active sentences. | general 0.71 | 1.68 | 0.15 | 5 | Keep. Uncertain class, but frequent. Vale checks only parts of it. | 2026-11-06 |

## Moved out of AGENTS.md

| ID | Instruction | Class | Freq | Impact | Now in | Reason | Date |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Edit `AGENTS.md` only. Never create a real `CLAUDE.md` or `GEMINI.md`. | general 0.97 | 1.41 | 0.77 | P1, `knowledge-curator`, the `agents-check` hook | Rule 5: uncertain, and frequency is below 1.5. The short form folds into P1 at no line cost. The hook catches a real file. | 2026-11-06 |
| M1 | Agent layout table, skill, subagent and MCP rules. | n/a | n/a | n/a | `.agents/AGENTS.md`, `docs/agentic-setup.md` | Needed only when an agent changes the agent configuration. The table repeated `docs/agentic-setup.md`. | 2026-11-06 |

M1 left before the triage of this ledger. It was not scored, because it was a table, not one rule.

## Lessons

- **Score the exact committed wording.** Repeated runs agree within about
  0.02, but a different wording can move class and frequency a lot.
