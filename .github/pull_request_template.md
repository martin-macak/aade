<!--
Title: type(scope): summary, in Conventional Commits form.
type is feat, fix, docs, chore or ci. Use feat for a type:enhancement
issue, fix for a type:bug issue and docs for a type:research issue.
scope is one of the scope:* labels in .github/labels.yml.
The pr-shepherd skill defines the format of Requirements and Verify, and
the pr-shepherd check enforces it. A PR without an issue gets the label
pr:no-issue and drops Closes and Requirements.
-->

Closes #

## Requirements

<!--
Copy each item of the issue's "Done when" or "Acceptance criteria"
verbatim, in order: `.agents/skills/pr-shepherd/scripts/shepherd.sh
requirements <issue>` prints them. Add sub-tasks as R<n>.<m>. Each ticked
leaf needs an evidence line: a path that this PR changes, an https URL,
or `command` -> result. Example:

- [x] R1: <issue item 1>
  - [x] R1.1: <sub-task>
    - evidence: path/to/changed/file
-->

- [ ] R1:

## Summary

-

## Verify

<!--
Checks that raise confidence. Each V item names the R items it verifies.
Example: - [x] V1 (R1, R2): `mise run check` passes
  - evidence: https://github.com/<owner>/<repo>/actions/runs/<id>
-->

- [ ] V1 (R1):

## Leftovers

<!--
Work that this PR leaves for later, such as a deferred review finding or
an issue item that moved out. After the merge, the leftovers workflow
files each open item as an issue. Take the type and the scope from
.github/labels.yml. Each indented line below an item becomes a Done-when
item of the issue. Tick an item to drop it. Example:

- [ ] chore(tooling): Pin the Vale package version
  - .vale.ini names an exact release.
-->

## Notes

<!-- Settings for an admin, risks, and the reason for each review row. Delete this section when it is empty. -->
