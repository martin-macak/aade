---
name: issue-authoring
description: >-
  How to open GitHub issues and pull requests in this repository so that
  they follow the issue forms, the pull request template and the label
  taxonomy in .github/ (type:<x> and scope:<x> labels). Use this skill
  whenever you open, write or edit a GitHub issue or a pull request, pick
  its type, scope or labels, write a PR title or body, or change the issue
  forms, the PR template or .github/labels.yml. Load it before you call
  `gh issue create` or `gh pr create`.
---

# Issue authoring

Issues and pull requests follow the files in `.github/`. People get the
issue forms in the web UI, and the forms enforce the required fields.
Agents use the command line, where `gh issue create` doesn't check any field. So
agents use the helper below, which enforces the same fields.

## Taxonomy

Each issue has one `type:<x>` label and one `scope:<x>` label.

- `.github/labels.yml` is the only list of labels. Read it to pick the
  type and the scope. The description of each type gives its
  Conventional Commits type. `type:enhancement` becomes `feat`, `type:bug` becomes
  `fix`.
- Each type has one issue form in `.github/ISSUE_TEMPLATE/<type>.yml`.
  The form sets the type label.
- The Scope dropdown of each form lists the scope values of `labels.yml`.
  The `issue-scope` workflow reads the `### Scope` section of the body
  and sets the `scope:<x>` label. It runs again when someone edits the body.

Never invent a type or a scope. A label that `labels.yml` does not list
does not exist, and the next sync deletes it.

## Open an issue

Run `mise run issue:new <type>` and pass the fields as YAML on stdin. The
keys are `title` and the `id` of each field in the form. Read the form
first to see its fields and which ones are required.

```sh
mise run issue:new chore --dry-run <<'YAML'
title: Pin the Vale package version
scope: tooling
what: |
  .vale.ini downloads ai-tells from a URL without a checksum. Pin it, so
  a new release cannot change the lint results.
done: |
  - [ ] .vale.ini names an exact release.
YAML
```

- Check the output of `--dry-run`, then run the same command without it.
- A checkboxes field takes `true`, `false`, or a list of the option
  labels to check.
- The helper fails, and opens nothing, when a required field is empty,
  a dropdown value is not an option, or a key is not a field of the form.
- Never call `gh issue create` directly. It skips these checks, and a
  body without the `### Scope` heading doesn't get a scope label.

To edit the body of an issue, keep every `### <label>` heading of its
form. The scope workflow reads the `### Scope` section.

## Open a pull request

Fill in `.github/pull_request_template.md` and pass it with
`gh pr create --body-file`.

- Title: `type(scope): summary` in Conventional Commits form. Take the
  type from the issue type and the scope from its scope label.
- First line: `Closes #<issue>`.
- Keep the template sections. Delete `Notes` when you have nothing to add.

## Change the taxonomy

1. Edit `.github/labels.yml`. To add a scope, also add it to the Scope
   dropdown of every form, in the same order.
2. To rename a label, add `from: <old name>` to its entry. A plain rename
   deletes the old label and removes it from every issue.
3. Run `mise run taxonomy:check`. It fails when the forms and
   `labels.yml` differ. Pre-commit and CI run it too.
4. Run `mise run labels:sync --dry-run` to see the changes for GitHub.

The `labels-sync` workflow applies `labels.yml` after merge to `main`.
Do not run `mise run labels:sync` without `--dry-run`. It changes the live
labels of the repository before review.
