# Controlling the CI node_modules cache

A cache hit and a cold install are different runs, and conflating them has already cost a session.
On a hit, bun does **not** re-run install scripts for a package it sees at the right version — so a
green check on a cache hit is not evidence that anything install-related works. `redis-memory-server`'s
broken postinstall stayed invisible for exactly this reason until a PR happened to touch `bun.lock`.

Four controls, cheapest first:

- **Read the state instead of guessing.** The `Report node_modules cache state` step emits
  `state=cache-hit|cold` three ways: the run summary (visible in the UI), a `::notice::` annotation
  (readable via `gh api repos/:owner/:repo/check-runs/<id>/annotations`), and a step output. Prefer the
  annotation when scripting — step outputs are **not** exposed by the Actions API, and `_verify.yml`
  declares no `workflow_call` `outputs:`, so the output is only usable inside that job. `gh api
  .../jobs` gives step *conclusions* but not this distinction, which is why the step exists at all.
- **`gh cache list` / `gh cache delete`** — self-service, no code change, effective immediately. The
  right tool for "this one cache entry is wrong, bin it".
- **The `refresh-cache` PR label** — skips cache restore for that PR only, forcing a real install
  without disturbing what other branches are using. Use it when a change alters install *behaviour*
  but no hashed manifest, since that PR would otherwise get a hit and never exercise its own change.
  **The label takes effect on the next push, not on being applied** — and this is the part that makes
  it work or not. `ci.yml` uses the default `pull_request` activity types, so labelling fires no run,
  and *Re-run all jobs* replays the original event payload in which the label is absent, silently
  coming back a cache hit. So: apply the label, then push — an empty commit is enough:

  ```bash
  gh pr edit <n> --add-label refresh-cache
  git commit --allow-empty -s -m 'chore: force a cold install' && RUN_CHECKS=yes git push
  ```

  Adding `labeled` to the trigger to remove that step was tried and reverted: it fires a full
  duplicate pipeline on **every** label event, and CONTRIBUTING.md makes one primary label mandatory
  on every PR — roughly +11 min of serialised CI per PR (see #156). Worse, every `pull_request` event
  shares the `refs/pull/N/merge` ref, so a `labeled` event lands in the same concurrency group with
  `cancel-in-progress` true and cancels the run already in flight, flipping required checks to
  `cancelled`. One deliberate empty commit is cheaper than that on every PR forever.
  (Skipping restore also skips the save, so a labelled run consumes nothing and publishes nothing.)
- **`vars.NODE_MODULES_CACHE_EPOCH`** (repository variable, defaults to `v1`) — bumping it invalidates
  every entry with no commit and no PR. Blunt and repo-wide; prefer the label or `gh cache delete`.

What the key covers: `bun.lock`, `bunfig.toml`, `package.json`, `.npmrc` and
**`tools/ci/install-deps.sh`** itself. That last one is there because the script sets the environment
the install runs under, and while nothing hashed it, a tree built under different install behaviour was
served from cache with no symptom. **Put install-affecting env in `install-deps.sh`** — it is hashed, so
behaviour and cache identity cannot drift apart.

Hashing the script is deliberately conservative: editing its comments costs a needless cold install on
every branch. That is the accepted price. The alternative was tried and reverted in #242 — a separate
`tools/ci/install.env`, parsed by hand so prose edits stayed cheap. Three review rounds found three
fail-open defects in that parser, each able to apply half an environment and return 0, which is exactly
the failure the separation existed to prevent. Sourcing returns the *last* command's status, so a bad
line mid-file is silently skipped; hand-parsing has to get `export`'s status, readonly names, quoting
and the grammar all right. A conservative key needs none of it. If prose edits ever become frequent
enough to matter, measure the cost before reaching for a parser again.

`tools/ci/install-deps.test.sh` asserts every one of those inputs is present, so dropping one fails
the build rather than silently widening what a stale entry can hide.

Scope caveat: `install-deps.sh` governs **CI's** install only. `Dockerfile` sets
`REDISMS_DISABLE_POSTINSTALL=1` itself, in the `base` stage, because it has three `bun install`
invocations and cannot read a CI script. The two are independent and nothing asserts they agree —
changing one means checking the other by hand.
