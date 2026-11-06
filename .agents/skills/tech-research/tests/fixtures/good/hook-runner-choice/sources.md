---
type: sources
title: "Hook runner choice"
status: final
created: "2026-11-01"
updated: "2026-11-02"
authors:
  - aade maintainers
---

# Hook runner choice

The register of every source that this research cites. Only
`research.sh source add` adds an entry. Each entry has the ID S<n>, and
other files cite it as a footnote.

## Register

### S1

| Field | Value |
| --- | --- |
| kind | primary |
| author | pre-commit maintainers |
| title | pre-commit documentation |
| url | https://pre-commit.com/ |
| published | unknown |
| accessed | 2026-11-01 |
| evidence | pre-commit installs each hook in its own environment and pins it to a git revision. |

### S2

| Field | Value |
| --- | --- |
| kind | primary |
| author | Evil Martians |
| title | Lefthook repository |
| url | https://github.com/evilmartians/lefthook |
| published | unknown |
| accessed | 2026-11-01 |
| archive | https://web.archive.org/web/2026/https://github.com/evilmartians/lefthook |
| evidence | Lefthook is one Go binary and can run the commands of a hook in parallel. |

### S3

| Field | Value |
| --- | --- |
| kind | primary |
| author | pre-commit maintainers |
| title | pre-commit source code |
| url | https://github.com/pre-commit/pre-commit |
| published | unknown |
| accessed | 2026-11-01 |
| evidence | pre-commit is a Python program. |

### S4

| Field | Value |
| --- | --- |
| kind | secondary |
| author | Jeff Dickey |
| title | mise documentation |
| url | https://mise.jdx.dev/ |
| published | unknown |
| accessed | 2026-11-02 |
| evidence | mise pins the version of each tool of a project in mise.toml. |
