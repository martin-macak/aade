---
type: report
title: "First look at hook runners"
status: superseded
created: "2026-10-01"
updated: "2026-11-02"
authors:
  - aade maintainers
superseded_by: hook-runner-choice
---

# First look at hook runners

Yes. pre-commit fits the repository as its first hook runner.

## Summary

```mermaid
flowchart LR
  R[Repository] --> P[pre-commit]
  P --> H[Pinned hooks]
```

The repository runs its checks through pre-commit, and pre-commit pins each
hook. The research hook-runner-choice replaces this answer.

## Key findings

- pre-commit pins each hook to a git revision.[^S1]
- The team knows pre-commit from other projects (unverified).

## Analysis

The pinned hooks match the rule that every tool has a pinned version.

## Risks and open questions

- The research looked at one runner only.

## Conclusion

The answer is yes, because pre-commit pins its hooks.

[^S1]: [S1](sources.md#s1) pre-commit maintainers, pre-commit documentation.
