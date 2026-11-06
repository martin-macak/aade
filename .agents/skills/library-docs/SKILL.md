---
name: library-docs
description: >-
  How to get current documentation for a library, framework, SDK, API, CLI
  tool or cloud service through the Context7 MCP server. Use this skill
  whenever a task depends on the current API, configuration or CLI flags of
  an external library or tool (mise, pre-commit, Vale, bats, GitHub Actions
  and others). Check even when you think you know the answer, because the
  versions in this repository are recent.
---

# Library docs

Your training data may predate the versions in this repository. Fetch
current docs before you rely on an API, a configuration key or a CLI flag.

## Workflow

1. Resolve the library ID with `resolve-library-id`, unless you already
   have an ID in `/org/project` form. Pick the match by exact name,
   description, snippet count, source reputation and benchmark score. Use a
   version-specific ID when the repository pins a version.
2. Query the docs with `query-docs`. Scope each query to one concept. Make
   a separate query per concept. Combined queries return shallow results.
3. Use the fetched docs in your answer or change.

Do not use Context7 for refactoring, scripts from scratch, business logic,
code review or general programming concepts. These tasks depend on the code
of this repository, not on the API of a library, so library docs do not
help.

## When Context7 is unavailable

1. Tell the user that Context7 is unavailable.
2. Read the official documentation of the library.
3. Run the tool to confirm a CLI flag, a configuration key or a behavior,
   when you can. Memory can predate the version in this repository.
