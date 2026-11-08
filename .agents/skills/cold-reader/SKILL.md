---
name: cold-reader
description: >-
  Quality gate for documentation pieces. Vale lints the piece, a cold reader
  on a cheap model restates it, and decisionkit scores the restatement and
  the slop. A piece is an edit to a skill or to an AGENTS.md, a README or
  docs/ page, a comment in a config file, a doc comment in code, or a status
  report that a script writes from data, such as a PR comment. Use this
  skill whenever you write, change or review any of these, even one
  sentence. Load it before
  you judge such a piece yourself. Use it before you commit or open a pull
  request that holds one.
---

# Cold reader

A piece is ready when a reader with nothing else can state its contract. The
gate checks this in order:

- Vale lints the piece.
- A cold reader restates it.
- decisionkit scores the restatement and the slop.

The cold reader is a fresh context on the cheapest model, with an empty
history and without tools. It sees each piece and the path where the piece
sits. A wrong restatement or an unclear point shows a gap that a human
reader will hit too.

## Scope

The procedure covers each of these pieces:

- edits to skills and to `AGENTS.md` files, root and nested;
- `README.md` and pages in `docs/`;
- comments in config files that explain a setting;
- doc comments in code that describe an exported interface;
- status reports that a script writes from data, such as a PR comment.

A new kind of piece, such as an API description, needs a bullet here and
a row in the table in "Start the reader". The drift tests compare the
description, this list and the table, so update all three.

## Procedure

1. **Run Vale.** From the repository root, run `mise exec -- vale <file>`
   and fix every finding. Reword the text. A rule has no exception unless a
   human maintainer approves it, because a disabled rule hides the same
   fault in every later piece. `.vale.ini` sets the rules: the `ai-tells`
   package and the `House` styles. It covers only `*.md` files, so for a
   config comment, save the text to a `.md` file in a temporary directory
   and lint that file. When Vale reports a missing `ai-tells` style, run
   `mise exec -- vale sync`. The package is downloaded, not committed.
2. **Start the cold reader** in a fresh context. Send it the prompt, each
   piece, and the path and heading or key of the place where the piece
   sits. Send nothing else, because code and conversation let the reader
   guess what the piece leaves out.
3. **Read the answer.** Take the restatement and the list of unclear points
   for each piece.
4. **Score each piece with decisionkit.** A piece passes when `Q_MATCH` is
   true and the `Q_SLOP` expected value is below `SLOP_MAX`.
5. **Fix and repeat.** When a check fails, rewrite the piece from the list
   of unclear points. Then run steps 1 to 4 again. That is one round. After
   3 rounds, stop and ask the user.

The `vale` pre-commit hook lints each staged `.md` file again. It can only
block a commit, and it cannot reword the text. Run step 1 early, so that no
finding stops the commit late. `mise run prose:lint` lints every tracked
`.md` file.

## Start the reader

Use the cheapest model that your agent offers, which is the one with the
lowest price. Each agent starts it in its own way:

- Claude Code: a `haiku` subagent. Another way is the command below. Before
  you run it, save the prompt and the pieces in a file, and set
  `prompt_file` to the absolute path of that file.
- Codex, Gemini CLI, Cursor and GitHub Copilot: a subagent on the cheapest
  model, or a new session.

```sh
(cd "$(mktemp -d)" && CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 claude -p \
	--model haiku --tools "" --setting-sources "" --disable-slash-commands \
	--strict-mcp-config --no-session-persistence <"$prompt_file")
```

The empty directory and the flags keep project rules, tools, skills and
memory out of the reader. Give the reader this as the path:

| Piece | The reader gets |
| --- | --- |
| Skill or `AGENTS.md` edit | The path of the file and the heading of the section |
| README or docs page | The path of the page and the heading of the section |
| Config comment | The path of the file and the key that the comment explains |
| Doc comment | The path of the file and the name of the interface that the comment describes |
| Status report | The path of the script that writes the report and the name of the report |

## Batch

Put all pieces of one change into one cold-reader run. Number them. Cut a
skill, an `AGENTS.md`, a README or a docs page into one unit for each
section. Keep a config comment and a status report whole. A reader cannot
restate a whole file, and `Q_MATCH` rates a long restatement low. The reader answers under each
number. Then score each unit on its own, because decisionkit takes one text
at a time.

## Status reports

A status report is text that a script writes from data, such as the trace
comment that a check posts on a pull request. It has two parts:

- The fixed text is the strings in the script: headings, legends, verdict
  lines, hints and footers.
- The data is each value that the script fills in from its input: IDs,
  text quoted from an issue, statuses, numbers and links.

`Q_SLOP` rates a table of data rows at about 1.0, whatever its wording,
and the script cannot reword its input. So gate the two parts apart:

- Run Vale and `Q_SLOP` on the fixed text only. Write each hint once, as a
  list item, and leave out the data.
- Do not score the data for slop.
- Send the whole report to the cold reader as one piece, and score
  `Q_MATCH` on all of it.

Gate a sample report, such as a golden file in the tests of the script,
each time the fixed text changes. The rule covers only text that a script
writes from data. An agent or a person who writes a report writes prose,
and `Q_SLOP` scores all of it.

## Prompt

Send the prompt block below to the reader, unchanged. After it, in the same
message, add one block for each piece. Number the blocks from 1, and put a
blank line between two blocks. A block starts with the line
`N. Path: <value>`. The value is the path and the heading or key from the
table above. The line `Piece:` follows, and then the text of the piece. The
reader answers each number with the parts `Restatement:` and `Unclear:`.

```text
You see numbered documentation pieces. Each piece has the path of the file
and the heading or key where it sits. Use only the text of that piece for
its answer.

For each piece, answer in two parts.
Restatement: say in your own words what this piece is for, and what a
reader must know or do. Cover every fact of the piece, with its exact
values, limits, errors and conditions. Add no fact. Fill no gap with a
guess.
Unclear: list anything unclear, including every fact that you had to guess.
Write "nothing" when all is clear.
```

## Questions

`Q_MATCH` checks that the restatement gives the same contract as the piece.
`Q_SLOP` rates the slop in the piece. `MATCH_MIN` is the threshold of
`Q_MATCH`, and `SLOP_MAX` is the limit of `Q_SLOP`.
[`scripts/calibrate.sh`](scripts/calibrate.sh) reads this block. So does the
`slop` layer of the knowledge-curator test runner. Do not rename the fence
or the variables.

```sh questions
Q_MATCH="Text A documents one element of a codebase, or gives an instruction \
about it. Text B is a reader's restatement of A in other words. Does B \
state the same contract as A, with nothing important missing, added or \
wrong? Judge the facts, values, limits and conditions, not the wording or \
the structure."
MATCH_MIN=0.8
Q_SLOP="Rate the slop in this documentation piece. Slop is text that gives a \
reader no fact: filler, hype, hedging that hides the rule (probably, \
usually, hopefully, in some cases), a restatement of the name or signature, \
a vague claim without a rule, and narration by an agent or an author (I, \
let me, here is). none: every sentence gives a fact that a reader needs, \
such as what the element does, who uses it and why, its inputs, results, \
errors or limits. some: one or two phrases or sentences give no fact, or a \
needed fact is vague. heavy: most of the text gives no fact."
SLOP_MAX=0.65
```

## Run the checks

Set the variables of the `sh questions` block in your shell. Send `Q_MATCH`
the calibrated input form: the line `A:`, the piece, the line `B:`, and then
only the restatement. Do not send the list of unclear points.

```sh
printf 'A:\n%s\nB:\n%s\n' "$piece" "$restatement" |
	decisionkit binary "$Q_MATCH" --threshold "$MATCH_MIN" --quiet
printf '%s\n' "$piece" |
	decisionkit score "$Q_SLOP" none some heavy --quiet
```

`Q_MATCH` exits 0 when the restatement matches, and 1 when it does not. Exit
code 2 is an error: run `decisionkit status`. `Q_SLOP` prints an expected
value from 0 (`none`) to 2 (`heavy`). It weighs the whole probability
distribution. The piece must score below `SLOP_MAX`.

## Calibration

`MATCH_MIN` is 0.8 by design. Only `SLOP_MAX` comes from calibration. It ran
with decisionkit 0.4.0 and the Jev provider. The highest good piece scored
0.43 and the lowest bad piece scored 0.9, so `SLOP_MAX` sits between them.
Calibrate again after you change the provider or upgrade decisionkit.

Run [`scripts/calibrate.sh`](scripts/calibrate.sh) from the repository root
after you change a question, a threshold or a fixture. Start it with
`mise exec --`, so that the pinned decisionkit and `jq` apply.
`make -C .agents/skills/cold-reader calibrate` does the same. The script
scores the synthetic fixtures in [`references/fixtures/`](references/fixtures/)
and exits 0 only when each fixture is on its expected side:

- `slop/good` and `slop/bad` hold pieces that must pass or fail `Q_SLOP`.
- `match/same-*` holds restatements that must pass `Q_MATCH`.
- `match/differ-*` holds restatements that must fail it.

Many fixtures show piece kinds that this repository does not have yet, such
as API descriptions. They stay, because they calibrate the
thresholds on prose, and those kinds join later. The `status-report-*`
fixtures in `slop/good` and `slop/bad` contain only the fixed text of a
report, because `Q_SLOP` scores only that text, as "Status reports" says.

The script reads only fixtures whose names end in `.txt`, and it skips any
other file without a message. It needs `jq` as well as decisionkit.

Scores drift between runs by up to 0.1. Never change a question or a
threshold to let one piece pass. Reword the piece.

## Privacy

decisionkit sends the text to its provider, and a hosted cold reader sees the
piece too. Never put secrets, credentials or personal data in a piece or in a
fixture. Read the [decisionkit skill](../decisionkit/SKILL.md) for the
provider rules.
