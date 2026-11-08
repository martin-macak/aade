---
type: sources
title: "Cache of hook environments in CI"
status: final
created: "2026-11-03"
updated: "2026-11-04"
authors:
  - aade maintainers
---

# Cache of hook environments in CI

The register of every source that this research cites. Only
`research.sh source add` adds an entry. Each entry has the ID S<n>, and
other files cite it as a footnote.

## Register

### S1

| Field | Value |
| --- | --- |
| kind | primary |
| author | pre-commit maintainers |
| title | pre-commit documentation: managing CI caches |
| url | https://pre-commit.com/#managing-ci-caches |
| published | unknown |
| accessed | 2026-11-03 |
| evidence | pre-commit keeps the hook environments in one cache folder, and a CI job can cache that folder between runs. |

### S2

| Field | Value |
| --- | --- |
| kind | primary |
| author | GitHub |
| title | actions/cache repository |
| url | https://github.com/actions/cache |
| published | unknown |
| accessed | 2026-11-03 |
| evidence | The cache action saves a folder under a key and restores it in a later run of the workflow. |
