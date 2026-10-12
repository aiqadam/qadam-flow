# #453 — macOS `/var` symlink and the worker `cache-paths` test: already fixed, kept as a repro recipe

**Status:** no code change required — the fix the issue proposes is already on `main`.
**Investigated:** 2026-10-12, on `origin/main` (`b3b9bcca`).

## What the issue reports

`packages/server/worker/test/lib/cache/cache-paths.test.ts` → `deleteStaleCache > leaves an
idle-looking stale directory in place, and logs a warning, when checking its age fails for a
reason other than it already being gone` fails on macOS:

```
AssertionError: expected [ 'v12' ] to deeply equal [ 'v11', 'v12' ]
```

Mechanism, as reported: the test builds `staleDir` from the **un-resolved** `mkdtemp` return
value (`os.tmpdir()` is under `/var/folders`, a symlink to `/private/var/folders`), then
`process.chdir(tempDir)`s into it. `process.cwd()` afterwards reports the *resolved*
`/private/var/...` path, so `path.resolve('cache')` inside `deleteStaleCache` never
string-matches `staleDir` in the `EACCES` mock keyed on `target === staleDir`. The mock misses,
the real `stat` runs, sees a genuinely 10-day-idle directory, and deletes it.

## Finding: the proposed fix is already in the tree

`packages/server/worker/test/lib/cache/cache-paths.test.ts:29` already resolves the temp dir
once, before `chdir`:

```ts
tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cache-paths-test-')))
```

Blame attributes this line (and the comment above it) to commit `1d5d5dee` — *"ci(e2e): wire a
real Mailpit into the CI e2e job (#342)"*, PR #459, merged 2026-09-18. That PR carried a
secondary commit *"fix(worker): resolve the macOS tmpdir symlink before comparing paths in
cache-paths.test.ts"* which fixed this exact test as a drive-by. Neither commit message nor the
PR body mentions `#453`, so the issue was never auto-closed and remains open.

The same `realpath(mkdtemp(...))` pattern is already used by the neighbouring suites
(`engine-installer.test.ts`, `code-builder.test.ts`, `code-builder-dependencies.test.ts`,
`qadams/qadam-version-store-root.test.ts`), so this is the established convention in the
directory.

## Verification

CI is Linux-only and `/tmp` there is not a symlink, so the failure cannot appear on CI. To prove
the fix is load-bearing, the macOS condition was reproduced on Linux by pointing `TMPDIR` at a
symlinked directory — Linux `getcwd()` also returns the physical path, matching macOS:

```bash
mkdir -p /tmp/macsim/real && ln -sfn real /tmp/macsim/link

# mkdtemp returns .../link/xxxx, but cwd after chdir is .../real/xxxx:
TMPDIR=/tmp/macsim/link node -e \
  "const {mkdtemp}=require('fs/promises');const {tmpdir}=require('os');const p=require('path');
   (async()=>{const d=await mkdtemp(p.join(tmpdir(),'x-'));console.log('mkdtemp:',d);
   process.chdir(d);console.log('cwd   :',process.cwd())})()"

cd packages/server/worker
TMPDIR=/tmp/macsim/link npx vitest run test/lib/cache/cache-paths.test.ts
```

Results:

| Tree state | `TMPDIR` | Outcome |
| --- | --- | --- |
| `origin/main` (`realpath`) | symlinked | **6 passed** |
| `realpath` removed by hand | symlinked | **1 failed** — `expected [ 'v13' ] to deeply equal [ 'v11', 'v13' ]`, the exact issue symptom |
| `origin/main` (`realpath`) | normal `/tmp` | **6 passed** |

The failing case was produced by temporarily changing line 29 back to
`tempDir = await mkdtemp(join(tmpdir(), 'cache-paths-test-'))`; the only failing test was the
one named in the issue, and restoring the line returns it to green.

## Recommendation

- Close #453 as already fixed by `1d5d5dee` / PR #459; no code change is needed.
- If a regression guard is ever wanted, the symlinked-`TMPDIR` run above is a portable,
  Linux-runnable repro of the macOS class of bug and is worth keeping for the next `mkdtemp`
  test that `chdir`s and compares a path built from that temp dir against a mocked `fs` call.

## Broader scope check

Every other server test that calls `process.chdir` already resolves its temp dir
(`cache-paths.test.ts`, `engine-installer.test.ts`, `qadam-platform-modules.test.ts`), except
`packages/server/api/test/unit/app/qadams/bundled-qadams-manifest.test.ts`, which `chdir`s into
a raw `mkdtemp` root but never compares an absolute path against a mocked `fs` call, so it is
not exposed to this failure mode.
