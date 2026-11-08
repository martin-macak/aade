---
type: brief
title: "Tech stack for the main application"
status: final
created: "2026-11-08"
updated: "2026-11-08"
authors:
  - aade maintainers
depth: quick
artifacts: []
---

# Tech stack for the main application

This parent research lists the technology decisions for the main application and links the child research behind each decision.

## Question

Which technologies make up the stack of the main application, and which child research decides each one?

Sub-questions:

- Which parts of the stack have a decision?
- Which parts of the stack still need a child research?

The answer is a list of the parts of the stack. Each entry gives the chosen technology and its child research, or states that the decision is open.

## Background

Issue [#46](https://github.com/martin-macak/aade/issues/46) asks for the stack of the main application and names the slug `app-tech-stack/ui-framework`. `research.sh` requires the parent `app-tech-stack` before it creates that child. The parent lists the parts of the stack, and each part with a decision has its own child research. `ui-framework` is the first child.

## Scope

### In scope

- The list of child researches and the outcome of each one.

### Out of scope

- The evidence for each part of the stack. That evidence stays in the sources and artifacts of each child research.

## Constraints

- Each child research states its own constraints.
- The parent report doesn't add a decision unless a child research supports it.

## Success criteria

- [ ] The report links each child research and states its outcome.
- [ ] The report lists each part of the stack that still needs a child research.

## Source policy

- Use the source policy of each child research.
- The parent registers only the primary sources that its report cites directly.
