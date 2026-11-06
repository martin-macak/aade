---
type: brief
title: "Hook runner choice"
status: final
created: "2026-11-01"
updated: "2026-11-02"
authors:
  - aade maintainers
depth: quick
artifacts:
  - comparison
  - recommendation
  - tech-profile
  - experiment
---

# Hook runner choice

This research is a test fixture of the tech-research skill. It shows a
complete research that passes `research.sh check`.

## Question

Which git hook runner should this repository use?

## Background

The repository runs its checks as git hooks before each commit. The team
wants to know if a one-binary runner is a better fit than pre-commit.

## Scope

### In scope

- pre-commit and Lefthook, in their current major versions.

### Out of scope

- Husky, because it needs Node in every clone.

## Constraints

- Every tool runs through mise with a pinned version.
- CI runs the same checks as the hooks.

## Success criteria

- The research picks one runner and gives the reason.
- The install time of each runner is measured.

## Source policy

Prefer the official docs and the source code of each tool.
