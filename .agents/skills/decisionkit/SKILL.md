---
name: decisionkit
description: >-
  How to use the decisionkit CLI for closed decisions in agentic workflows:
  yes/no checks, classification, triage, scoring and ranking with
  calibrated probabilities. Use this skill whenever an agent in this
  repository needs a choice between fixed options, a rating on a scale, a
  ranking or priority order of candidates (issues, tasks, findings), or a
  triage of an instruction, finding or issue. Load it before you answer
  such a question yourself, even an easy one.
  It does not cover open design choices, which need reasoning.
---

# decisionkit

decisionkit asks a decision API a closed question about some text. It
returns probabilities, not reasoning. Do not use it for open questions or
design choices. Those need reasoning, which decisionkit does not give.

## Commands

Pass the text on stdin or with `--context "…"`.

```sh
decisionkit binary "<question>" --threshold 0.8   # true|false <p_true>
decisionkit choice "<question>" opt1 opt2 opt3    # <choice> <p>
decisionkit score  "<question>" low mid high      # <level> <p> (expected <n>)
decisionkit rank   "<question>" cand1 cand2       # best first
```

Useful options: `--json` for the full result, `--quiet` to hide the
provider notice, `--plain` for script-friendly output.

## Read the result

- **Exit codes:** `0` means true or confident, `1` means false or below
  `--threshold`, and `2` means an error.
- **Below 0.8 is uncertain.** Then decide yourself and state the reason,
  or ask the user. Do not present an uncertain result as a decision.
- **An error is never an answer.** On exit code `2`, run
  `decisionkit status` and fix the cause. `mise run agents:health` also
  checks decisionkit.
- **Phrase questions so the options are exclusive and complete.** Define
  each option in the question. Vague options give flat probabilities.

## Facade

`scripts/decide.sh` asks a closed question from a questions file. Callers
that share the file get the same question, options, threshold and output.
Use the facade when two or more callers send a question, or when one
caller sends it in a loop.

```text
scripts/decide.sh ask <questions-file> <name> [--context <text>] [<candidate>...]
scripts/decide.sh calibrate <questions-file> <fixtures-dir>
```

- A questions file is YAML. Its list `questions` has one entry for each
  question, with `name`, `kind` (`binary`, `choice`, `score` or `rank`),
  `text`, `options` and `threshold`.
- `threshold` is the `--threshold` of decisionkit. Without it, a `binary`
  question uses 0.5, and a `choice` or a `score` uses `UNCERTAIN_MIN`.
- `ask` reads the text on stdin, or from `--context`. Only a `rank`
  question takes candidates, at least two. Any other question exits 2 when
  it gets candidates. It prints one JSON line with `name`, `kind`,
  `answer`, `p`, `expected`, `threshold` and `uncertain`. Its exit codes
  are those of decisionkit.
- `uncertain` is true when the top probability is below `UNCERTAIN_MIN`.
  For a `rank` question, it is true when the top two expected levels differ
  by less than `RANK_TIE`.
- `calibrate` scores each fixture `<fixtures-dir>/<name>/<label>-*.txt`.
  The label is the answer that the fixture expects: `true` or `false`, or
  an option. The label ends at the first hyphen of the file name, so an
  option with a hyphen cannot be a label. `calibrate` skips `rank`
  questions, because their answer is an order, not one label. It exits 0
  when each fixture gets its label, 1 when a fixture does not, and 2 on an
  error. A fixture that gets its label from an uncertain answer still
  passes, but it is marked `uncertain`, because a caller may not present
  such an answer as a decision. The last line counts the `ok`, the
  `uncertain` and the wrong fixtures. Each fixture counts in one group
  only. For a `binary` question, it prints the lowest probability of a
  `true` fixture and the highest of a `false` one. Set the threshold in
  the middle of that gap.

The script reads this block. Do not rename the fence.

```sh facade
UNCERTAIN_MIN=0.8
RANK_TIE=0.1
```

## Privacy

decisionkit sends the text to the provider in `DECISIONKIT_PROVIDER`.
Each contributor sets it in the `[env]` table of `mise.local.toml`,
which Git ignores. Never send secrets,
credentials, personal data, or code that is not cleared for that provider.
Send raw text only when you read all of it and it holds none of these.
Otherwise send a summary of at most 3 sentences.
