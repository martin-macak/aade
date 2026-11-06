---
type: recommendation
title: "Keep pre-commit"
status: final
created: "2026-11-02"
updated: "2026-11-02"
authors:
  - aade maintainers
---

# Keep pre-commit

We keep pre-commit as the hook runner.

## Context

Every tool of the repository has a pinned version.[^S4] The hook runner
must keep the hooks pinned too.

## Options considered

- pre-commit: pinned hooks, but it needs Python.[^S3]
- Lefthook: a fast install, but no pinned hook repositories.[^S2]

## Decision

We use pre-commit, because it pins each hook to a git revision.[^S1]

## Consequences

The setup task keeps installing Python through mise. Each machine runs the
same hook versions.

## Follow-up

- Measure the hook run time again when a new hook joins.

[^S1]: [S1](sources.md#s1) pre-commit maintainers, pre-commit documentation.
[^S2]: [S2](sources.md#s2) Evil Martians, Lefthook repository.
[^S3]: [S3](sources.md#s3) pre-commit maintainers, pre-commit source code.
[^S4]: [S4](sources.md#s4) Jeff Dickey, mise documentation.
