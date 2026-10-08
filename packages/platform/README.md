# `@aiqadam/platform`

Not code. This package exists so that a changeset can declare the **platform** release level
(ADR-0001, "What each number means": the layer whose contract is with instance operators).

Changesets versions workspace packages only — a changeset naming the monorepo root
(`qadam-flow`) fails with `package qadam-flow which is not in the workspace` (verified with
`@changesets/cli@3.0.3`). So the platform version lives here as well as in the root
`package.json`:

- a PR that changes the platform for operators adds a changeset with `"@aiqadam/platform": <level>`;
  a `major` needs an entry in `docs/install/configuration/breaking-changes.mdx` (gate 4);
- the release PR runs `tools/scripts/changesets/version.mjs`, which runs `changeset version` and
  then copies this package's version into the root `package.json`;
- `tools/ci/check-changesets.mjs` fails any PR in which the two disagree.

Both hold the **last released** version (ADR-0001), never the next one: `1.1.0` until the first
release PR, which the pending `"@aiqadam/platform": major` (`.changeset/platform-2-0-0.md`) takes to
`2.0.0`. Images built from `main` report `<next>-main.<n>` instead, computed from this version and
the pending platform changesets by `tools/ci/compute-main-version.mjs` (#798).

It is `private` and has no dependencies, so it is never published and no other package's release
can cascade into it.
