# Research

Each folder here contains one technical research. The folder name is the
slug of the research. A research answers one question that a brief states,
and it cites a source for each claim or marks the claim unverified.

The [tech-research skill](../../.agents/skills/tech-research/SKILL.md)
defines the format, the artifact types and the workflow. Its tool
creates and checks the files. Run `mise run research:check` to check every
research. The `research-check` pre-commit hook and CI run the same check.
