# #798 — "Platform version: last-released root version, -main.<n> prereleases, image tag scheme, tag v2.0.0": every in-scope item is already implemented or already blocked on a maintainer action

**Status:** no code change required in this ticket's own scope.
**Investigated:** 2026-11-08, on `agent/798-platform-version-last-released-root-vers`
(branch created at `main`'s current head, `c39ecd8c`).

## What the issue asked

Four scope items (issue body checklist):

1. Compute the `-main.<n>` prerelease in the `main` image build (`ci.yml`) and pass it
   into the image so `getCurrentRelease()` reports it.
2. Image tag scheme in `ci.yml` and `release.yml`.
3. Tag `v2.0.0` through the first changesets release PR.
4. Update #116 (canary) to the `:main` tag and the prerelease version.

Explicitly out of scope: how `main` images version unreleased qadam/package code
(tracked separately in #784).

## Finding: items 1, 2 and 4 are merged on `main`; item 3 is blocked on a maintainer secret, not on code

The issue's own first comment (by @binalirustamov) already records that #828 delivered
items 1, 2 and the tag scheme, and that item 3 is "blocked on `CHANGESETS_TOKEN` (#796)".
This session re-verified each of those claims directly against the current tree rather
than taking the comment's word for it:

- **Item 1 — `-main.<n>` compute step.** `.github/workflows/ci.yml:1009-1046` computes
  `<next>-main.<n>` from the pending platform changeset and the `ci.yml` run number, and
  stamps it into the image's `package.json`. `apVersionUtil.getCurrentRelease()`
  (`packages/server/api/src/app/qadams/metadata/utils/qadam-cache-utils.ts` and callers in
  `flag.service.ts`, `telemetry.utils.ts`, `machine-service.ts`, the qadam-metadata
  service and five flow-version migrations) reads that stamped value at runtime, exactly
  as the issue asks.
- **Item 2 — tag scheme.** `ci.yml:1162-1233` tags `main` builds
  `:<version>` (`2.0.0-main.<n>`), `:main` and `:sha-<short>`; `release.yml:452-501` tags
  a release `:<version>` plus `:latest`/moving tags, gated by `version-tag-gate`
  (`release.yml:90`, which `tools/ci/test-version-tag-gate.sh` exercises) keeping the git
  tag and the version the image reports equal.
- **Item 4 — #116 updated.** #116 already carries a comment (by @binalirustamov) stating
  the canary should pull `:main`, not assume the root `package.json` version, and pointing
  at this issue as the implementation. No further edit needed there.
- **Item 3 — tag `v2.0.0`.** Still genuinely open, and still not something this session
  (or any worker) can close: `changesets.yml` ("Open or update the release PR") has failed
  on **every** push to `main` since before this session started, most recently on
  `c39ecd8c` (run `42500501257`, 2026-11-08T16:33Z) with
  `##[error]Bad credentials - https://docs.github.com/rest` at the `changesets/action` step
  — after it had already computed `platform 1.1.0 -> 2.0.0` correctly and written the root
  `package.json` locally. The failure is the GitHub API call the action makes to push the
  branch and open/update the PR, not the version computation. #796's own remaining list
  names this as a **maintainer** action ("add the repo secret `CHANGESETS_TOKEN`"), which
  needs org-level permission this session does not have and should not acquire for itself.

## Why no code change was made here

There is nothing left in this issue's scope to implement: the `-main.<n>` compute step,
the tag scheme in both workflows, and the #116 update are all on `main` today, verified
against the actual files rather than the issue comment's summary. The one remaining
checklist item is blocked on a repository secret only a maintainer can add, and then on
that maintainer merging the automated `chore(release): version packages` PR without
hand-editing any version — not on anything a worker can implement in `src/` or CI YAML.
Opening a hand-written substitute release PR would duplicate (and could conflict with)
the automated one once the secret is added, which is the opposite of "merge it without
hand-editing any versions" that #796 asks for.

## Recommendation

- Leave #798 open; its only remaining item is the same blocked item #796 already tracks.
- A maintainer adds `CHANGESETS_TOKEN` (fine-grained PAT, Contents + Pull requests
  read/write) as a repo secret, per #796. Once added, the next push to `main` lets
  `changesets.yml` open the release PR on its own; merging that PR (unedited) is what
  actually produces the `v2.0.0` tag this issue asks for.
