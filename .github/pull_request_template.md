<!--
  Thanks for contributing to Qadam Flow!
  Keep PRs small and focused — one logical change per PR.
-->

## What & why

<!-- What does this PR change, and why? Link the issue it addresses. -->

Closes #

## How it works

<!-- Brief notes for reviewers: approach, trade-offs, anything non-obvious. A screenshot or short clip helps for UI changes. -->

## Checklist

- [ ] **Signed off every commit** with `git commit -s` (DCO — required, see [CONTRIBUTING](../CONTRIBUTING.md#commits-and-the-dco)).
- [ ] Applied **exactly one** primary label: `feature`, `bug`, or `skip-changelog` (and `area/core-qadams` / `area/third-party-qadams` if this touches `packages/qadams`).
- [ ] PR title follows Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, …).
- [ ] Tests added/updated where it makes sense; lint and build pass locally.
- [ ] **Changeset** for every versioned package this changes (a qadam, `@aiqadam/qadams-framework` / `-common`, `@aiqadam/platform` for operator-facing changes): `npx changeset`. Do not edit `version` by hand — the release PR raises it ([ADR-0001](../adr/0001-everything-versioned-follows-semver-declared-with-changesets.md)).
- [ ] **Does this change behaviour an existing step would notice** — same inputs, different result, timing or side effect? CI cannot see that; if yes, it is a breaking change for that qadam and the changeset says so (major, or minor while the qadam is on `0.x`).
- [ ] Docs / translations updated if behaviour changed.
- [ ] If this implements an ADR, or adds or supersedes one, the ADR is linked (`ADR-NNNN`, see [`adr/README.md`](../adr/README.md)); implementation merges only once that ADR is `accepted`.
