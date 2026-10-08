# Changesets

Every version number in this repository is raised here, not by hand ([ADR-0001](../adr/0001-everything-versioned-follows-semver-declared-with-changesets.md)).

A PR that changes a versioned package — a qadam, `@aiqadam/qadams-framework`, `@aiqadam/qadams-common`,
`@aiqadam/shared` while it is still published, or the platform (`@aiqadam/platform`, for a change
operators notice) — adds a file here:

```md
---
"@aiqadam/qadam-slack": minor
---

Add the "Schedule message" action.
```

`npx changeset` writes one interactively. The release PR ("chore(release): version packages",
opened by `.github/workflows/changesets.yml`) collects them, raises the versions, writes the
changelogs and removes the files. It never publishes or tags; a maintainer tags the merged result.

CI checks it: `tools/ci/check-changesets.mjs` (a changed package has a changeset; no hand-edited
`version`), `tools/ci/check-changeset-levels.mjs` (the level is not below what the qadam's props
diff computes). The rule for choosing a level is ADR-0001's table "What each number means".
