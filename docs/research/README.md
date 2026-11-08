# Research

Each folder in this directory contains one technical research. The folder
name is the slug of the research. A research answers one question that a brief states,
and it cites a source for each claim or marks the claim unverified. A
large research can split into sub-slug folders inside its own folder, one
level deep. Each sub-slug folder is a full child research with its own
brief, report and sources.

The [tech-research skill](../../.agents/skills/tech-research/SKILL.md)
defines the format, the artifact types and the workflow. Its tool,
`research.sh`, creates and checks the files. Run `mise run research:check` to check every
research and every sub-slug. The `research-check` pre-commit hook and CI run the same check.

To ask for a research, open an issue with the Research form. It is
`.github/ISSUE_TEMPLATE/research.yml`, and its fields match the sections,
the depth and the artifact types of the brief.
`research.sh init <slug> --issue <number>` writes the brief from the
issue, and the user approves it before the research starts.
