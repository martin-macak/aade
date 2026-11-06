---
name: tech-research
description: >-
  Controlled technical research in docs/research/<slug>/. Each research has
  an approved brief, a source register that cites the original authors, and
  typed Markdown artifacts from templates. scripts/research.sh creates and
  checks them. Use this skill whenever a user asks you to research,
  investigate, evaluate or compare a technology, library, service, vendor or
  approach, or asks "which X should we use" or "should we adopt Y". Use it
  also for a spike. Use it for every task on a file in docs/research/, such
  as a fix, a new source, a status change or a failing research-check hook
  or research.sh check. Load it before you search the web for such a
  question or edit such a file.
---

# Tech research

A research answers one technical question for this repository. It lives in
`docs/research/<slug>/` and holds typed artifacts. Each artifact is a
Markdown file with YAML front matter, built from a template of this skill.
Every claim cites a source, and every source records its author. A reader
can trace each fact to its origin.

`scripts/research.sh` does each action that must give the same result
every time. It creates the files, gives each source its ID and writes the
footnotes. It also moves the status and checks the folder. Never do these by hand, because a hand
edit drifts from the format that the check enforces. Run the tool from the
repository root:

```sh
R=.agents/skills/tech-research/scripts/research.sh
mise exec -- $R check
```

## Workflow

```mermaid
flowchart LR
  A[Request] --> B[init and draft brief]
  B --> C{User approves?}
  C -- no --> B
  C -- yes --> D[brief final]
  D --> E[Collect sources]
  E --> F[Write artifacts]
  F --> G[cite sync and check]
  G --> H[review, then final]
```

The diagram shows the one loop of the flow: the brief returns to draft until
the user approves it. Sources and artifacts come only after that approval.

1. **Init.** Pick a kebab-case slug without a date, such as
   `vector-db-choice`. Run `$R init <slug> --title <t> --author <a>`. It
   creates `brief.md`, `report.md` and `sources.md`. Add
   `--depth quick|standard|deep` (default `standard`), and one
   `--artifact <type>` for each optional type that the question needs.
2. **Draft the brief.** Fill every section of `brief.md` from the request.
   Ask the user only about the fields that the request leaves open. Run
   `$R status <slug> brief.md review`.
3. **Get approval.** Show the brief to the user. On approval, run
   `$R status <slug> brief.md final`. If the user asks for changes, run
   `$R status <slug> brief.md draft`, edit, and ask again. Do not research
   before approval. After approval, only the user can change the brief.
4. **Collect sources.** Read each source, then record it at once with
   `$R source add` (see [Sources](#sources)). The command prints the ID.
5. **Write the artifacts.** Replace each `<!-- fill: -->` comment with
   content. Cite with `[^S<n>]`. Add a file of an optional type with
   `$R add <slug> <type> --title <t> --author <a>`. Add `--name <n>` for
   a second file of the same type, named `<type>-<n>.md`.
6. **Sync and check.** Run `$R cite sync <slug>`, then `$R check <slug>`,
   and fix every problem.
7. **Finish.** Run `$R status <slug> <file> review` for each file. After
   the user accepts the file, run `$R status <slug> <file> final`. Run the
   `cold-reader` gate on your prose before you commit.

## Artifact types

The set is closed. `references/types.yml` defines it, and
`references/templates/<type>.md` holds the template of each type. A
required type is in every research. A repeatable type may have more files,
named `<type>-<name>.md`. A diagram type needs at least one Mermaid
diagram from status `review` on.

| Type | Required | Repeatable | Diagram | Answers |
| --- | --- | --- | --- | --- |
| `brief` | yes | no | no | What do we ask, and what limits apply? |
| `report` | yes | no | yes | What is the answer, and on what findings does it rest? |
| `sources` | yes | no | no | Who said each fact, and where? |
| `comparison` | no | yes | yes | Which option ranks first against weighted criteria? |
| `recommendation` | no | yes | no | What do we decide, and what follows from it? |
| `tech-profile` | no | yes | yes | How does one technology work, and does it fit? |
| `experiment` | no | yes | yes | Does a spike confirm the claim? |

The brief lists the optional types of the research in `artifacts`. The
check fails for a file whose type the brief does not list. From the time
the report is in `review`, the check also fails for a listed type without
a file. Put risks, glossaries and similar notes in a section of the report.

The front matter of each file has the fields `type`, `title`, `status`,
`created`, `updated` and `authors`. The brief adds `depth` and
`artifacts`. A superseded file adds `superseded_by`. The check rejects any
other key. The first heading of each file is `# <title>`. The tool writes
all of these, so the dates and the quoting stay the same in every file.
When a required file is lost, `$R add <slug> <type>` creates it again.

## Brief

The brief is the templated input. Its sections are Question, Background,
Scope, Constraints, Success criteria and Source policy. `depth` sets the
effort:

- `quick`: at least 3 sources. Usually the report alone.
- `standard`: at least 5 sources, 2 of them primary.
- `deep`: at least 10 sources. Each key finding has 2 sources that agree.

The check does not count sources. The depth tells the user what to expect.

## Sources

`sources.md` is the register. Each entry is a `### S<n>` heading with a
table of fields. Only `$R source add` writes an entry:

```sh
mise exec -- $R source add <slug> --kind primary --author "PostgreSQL Global Development Group" \
  --title "PostgreSQL 17 release notes" --url https://www.postgresql.org/docs/17/release-17.html \
  --published 2024-09-26 --evidence "Version 17 adds incremental backups to pg_basebackup."
```

- `kind` is `primary` (official docs, a spec, a paper, source code),
  `secondary` (vendor blog, talk, book) or `tertiary` (forum, personal
  blog, AI summary).
- `author` is the person or organisation that wrote the source, not the
  site that hosts it.
- `evidence` paraphrases what the research takes from the source.
  Do not paste a quote, because Vale lints the register too.
- `published` is the date of the source, or `unknown`. The tool sets
  `accessed` to today.
- `archive` is optional. For a primary web source, add a Wayback Machine
  link when one exists. It keeps the citation usable when the URL stops
  working.

The tool gives the next free ID, and it prints the old ID when the URL is in
the register already. Never invent a source, a URL or an author. A fact
without a source is marked `(unverified)`.

## Citations

Cite a source with a footnote reference, such as `[^S2]`, right after the
claim. GitHub renders a footnote only when its definition is in the same
file. So `$R cite sync <slug>` writes the definitions at the end of each
file, each with a link to the entry in `sources.md`. Never edit these lines.
The check fails when they are stale, or when a file cites an ID that is not in
the register.

Each item of `## Key findings` in the report cites at least one primary
source, or ends with `(unverified)`. The check enforces this from status
`review` on.

## Diagrams

Prefer a diagram to text when it shows the structure. Mermaid flowcharts,
sequence, component and state diagrams, and quadrant charts fit most
research, and GitHub renders them. Put a prose paragraph right after each
diagram. It says what the diagram shows and why it matters, because a
diagram alone does not state the reasoning. The check fails for a diagram
without such a paragraph, in every status.

## Status

```mermaid
stateDiagram-v2
  [*] --> draft
  draft --> review
  review --> draft
  review --> final
  final --> superseded
```

A file starts as `draft` and goes to `review` when it is complete. It goes
back to `draft` when the review finds a gap. After a successful
review, the file moves to `final`. When a newer research replaces it, it
moves to `superseded`.

Move a file only with `$R status <slug> <file> <status>`. A move to
`review` or `final` runs the check, and it keeps the old status when the
file has a problem. Only a final brief lets other files move to `review`.
A move to `superseded` needs `--by <slug>` with the slug of the newer
research.

These rules apply only to a file in `review`, `final` or `superseded`, so a
draft can be committed while it is incomplete:

- no `<!-- fill: -->` comment is left;
- a file of a diagram type contains a Mermaid diagram;
- each key finding cites a primary source or is `(unverified)`;
- each type that the brief lists has a file. This rule starts when the
  report moves to `review`.

## Check and enforcement

`$R check` checks every folder in `docs/research/`. `$R check <slug>`
checks one folder. It prints one line for each problem and exits 1 when it
finds one. `mise run research:check` runs it for all folders. The
pre-commit hook `research-check` runs it when a commit changes
`docs/research/`, and CI runs it through `mise run check`. The hooks
`vale` and `knowledge-lint` lint the research prose and links like any
other Markdown file.

## Tests

`make -C .agents/skills/tech-research test` runs the four layers of the
`knowledge-curator` skill. Its drift layer runs these bats files:

- `tests/fixtures.bats` runs `$R check` against the fixtures.
  `tests/fixtures/good/` is a research root that must pass. It holds a
  final research with every type, a draft in progress and a quick research
  with a superseded report. Each folder `tests/fixtures/bad/<case>/` has a
  `defect.diff` that adds one defect to a copy of the good root. Its
  `expect.txt` lists every problem line that the check must print, with
  paths relative to the root. The test fails on a missing or an extra line.
- `tests/research.bats` tests the other commands on a copy of the good
  root, with a fixed `RESEARCH_TODAY`.
- `tests/drift.bats` compares the facts of this file with the script, the
  types, the templates, `mise.toml` and the hooks.

For a new check rule, add a bad case. Change a copy of the good root in a
throwaway git repository, and save `git diff` as `defect.diff`. Then write
`expect.txt` by hand. Never copy the expected lines from the output of the check, because
the test must catch a wrong message too. The defect stays in the diff, not
in a tracked Markdown file, because the `knowledge-lint` and `vale` hooks
lint every tracked Markdown file. A good fixture must pass these hooks too.
