# ADR-0003 prototype — how the Evidence numbers were produced

Throwaway scripts, kept so the measurements in ADR-0003 can be re-run. Not product code.

Setup: a worktree of `origin/main` @ `94dc9ae3`, Node v24.21.0, `bun install --frozen-lockfile
--ignore-scripts`, then `bun run build` in `packages/shared`, `packages/qadams/framework`,
`packages/qadams/common`. A local dev container on a warm disk; not QA.

## Bundles and sizes

Each qadam's `src/index.ts` was bundled with the repository's esbuild, three ways:

```bash
E=node_modules/.bin/esbuild
# own code only (every package external)
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --packages=external --minify-syntax --outfile=own/<name>.js
# own code + third-party deps (only @aiqadam/* external) — the ADR-0003 artifact shape
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --external:'@aiqadam/*' --minify-syntax --outfile=own3p/<name>.js
# everything, including shared/framework/common
$E <qadam>/src/index.ts --bundle --platform=node --format=cjs --target=node22 --minify-syntax --outfile=full/<name>.js
```

Totals: `du -cb *.js` and `tar -czf - *.js | wc -c`. 235 of 238 bundled; `sftp`, `duckdb` and
`metabase` failed on native modules. `crypto` bundled but failed to load (`import.meta` in CJS).

Old versions were extracted with `git archive <commit> <qadam>/src` into a folder inside the qadam's
own directory (so third-party imports resolve against today's `node_modules`) and bundled the same
way — an approximation of the original artifact, not a reproduction. `csv@0.4.14` additionally
needed `xlsx@0.18.5`, which is no longer in the tree.

## Scripts

All load `@aiqadam/*` from one built copy: a `node_modules/@aiqadam/{shared,qadams-framework,
qadams-common}` symlinked to the worktree packages. Run with `node --expose-gc <script>`.

| Script | Measures |
| --- | --- |
| `load-versions.js` | heap and time of the platform libraries once, then `tables@0.3.1` / `0.4.5` / `0.5.1` side by side; props diff between them |
| `shared-copies.js` | heap and time of each extra copy of `shared` (copies of `dist` at different paths) |
| `run-csv.js` | `convert_csv_to_json` on `csv@0.4.14` / `0.5.0` / `0.6.0` in one process |
| `props-abi-diff.js` | props ABI of every core qadam, June (`f611ac80`) vs `94dc9ae3` |
| `catalogue-metadata.js` | size of `metadata()` JSON for every bundled qadam |

## Derived figures

- **Version churn**: `git log --since=2026-06-20 -p -- ':(glob)packages/qadams/*/*/package.json'`,
  counting distinct `+  "version":` lines per file → 239 across all qadams (≈ 820 a year).
- **Catalogue history ≈ 2 MB/year, gzipped**: one generation of metadata is 0.58 MB gzipped for 227
  qadams (≈ 2.6 KB each); ≈ 820 new versions a year × 2.6 KB ≈ 2.1 MB.
- **`shared` symbols used by qadams**: named imports from `@aiqadam/shared` across
  `packages/qadams/*/*/src/**`, multi-line imports parsed → 104 distinct symbols.
