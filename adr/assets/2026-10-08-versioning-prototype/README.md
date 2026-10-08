# 2026-10-08 versioning prototype — how the Evidence numbers were produced

Throwaway scripts, kept so the measurements cited by ADR-0001 and ADR-0003 can be re-run. Not
product code.

Setup: a worktree of `origin/main` @ `94dc9ae3`, Node v24.21.0, `bun install --frozen-lockfile
--ignore-scripts`, then `bun run build` in `packages/shared`, `packages/qadams/framework`,
`packages/qadams/common`. A local dev container on a warm disk; not QA.

## Bundles and sizes

Each qadam's `src/index.ts` was bundled with the repository's esbuild, three ways:

```bash
E=node_modules/.bin/esbuild
# own code only (every package external)
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --packages=external --minify-syntax --outfile=own/<name>.js
# own code + third-party deps (only @aiqadam/* external; the ADR-0003 artifact would also leave zod external)
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --external:'@aiqadam/*' --minify-syntax --outfile=own3p/<name>.js
# everything, including shared/framework/common
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --minify-syntax --outfile=full/<name>.js
```

Totals: `du -cb *.js` and `tar -czf - *.js | wc -c`. 235 of 238 bundled; `sftp`, `duckdb` and
`metabase` failed on native modules. `crypto` bundled but failed to load (`import.meta` in CJS).

Old versions were extracted with `git archive <commit> <qadam>/src` into a folder inside the qadam's
own directory — `tables@0.3.1` from `f611ac80`, `tables@0.4.5` from `48fb71f0`, `csv@0.4.14` from
`f611ac80`, `csv@0.5.0` from `2bccad76`; for the props diff every core qadam at `f611ac80` vs
`94dc9ae3` — (so third-party imports resolve against today's `node_modules`) and bundled the same
way — an approximation of the original artifact, not a reproduction. `csv@0.4.14` additionally
needed `xlsx@0.18.5`, which is no longer in the tree.

## Scripts

All load `@aiqadam/*` from one built copy: a `node_modules/@aiqadam/{shared,qadams-framework,
qadams-common}` symlinked to the worktree packages. Run with `node --expose-gc <script>`.

Inputs the scripts expect: `tables/<version>/index.js` and `csv/<version>/index.js` bundles next to
`load-versions.js` / `run-csv.js`; for `props-abi-diff.js`, `<qadam>/old.js` and `<qadam>/new.js` plus
a `list.txt` of `<qadam> <oldVersion> <newVersion> <built:1|0>` lines; for `shared-copies.js`, two
copies of `packages/shared/dist` (+ `package.json`, `node_modules` symlinked) in `s2/` and `s3/`, and
the worktree path, which is hard-coded as `/tmp/qf-proto`.

| Script | Measures |
| --- | --- |
| `load-versions.js` | heap and time of the platform libraries once, then `tables@0.3.1` / `0.4.5` / `0.5.1` side by side; props diff between them |
| `shared-copies.js` | heap and time of each extra copy of `shared` (copies of `dist` at different paths) |
| `run-csv.js` | `convert_csv_to_json` on `csv@0.4.14` / `0.5.0` / `0.6.0` in one process |
| `props-abi-diff.js` | props ABI of every core qadam, June (`f611ac80`) vs `94dc9ae3` |
| `catalogue-metadata.js` | size of `metadata()` JSON for every bundled qadam |

## Derived figures

- **Version churn**: `git log --since=2026-06-20 -p -- ':(glob)packages/qadams/*/*/package.json'`,
  counting distinct `+  "version":` lines per file → 239 across all qadams in 110 days (≈ 790 a year).
- **Catalogue history ≈ 2 MB/year, gzipped**: one generation of metadata is 0.58 MB gzipped for 227
  qadams (≈ 2.6 KB each); ≈ 790 new versions a year × 2.6 KB ≈ 2.1 MB.
- **Sizes, median and max**: `stat -c%s *.js | sort -n`, middle and last value.
- **Type drift**: each old `tables` source type-checked with `tsc -p` (a `tsconfig.json` extending the
  qadam's `tsconfig.lib.json` with `noEmit`) against today's built `shared` → 2 errors for 0.3.1, 3 for
  0.4.5.
- **`shared` symbols used by qadams**: named imports from `@aiqadam/shared` across
  `packages/qadams/*/*/src/**`, multi-line imports parsed → 104 distinct symbols.
