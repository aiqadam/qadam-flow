#!/usr/bin/env node
//
// Step 1 of #852 (ADR-0004, gate 9): lists the `0.x` official qadams whose tree build differs from
// the tarball npm serves for the same version. 46 did at `v1.1.0` (ADR-0001); this prints today's
// number. What "differs" means, what is not compared and why is in tools/ci/qadam-divergence.mjs.
//
// It measures; it does not judge. A qadam that already has a pending changeset is still listed (and
// marked), because the changeset does not change what the tree contains — it only means the next
// `main` build gives that qadam its own `-main.<n>` version (ADR-0004). The gate that does judge
// is tools/ci/check-qadam-divergence.mjs.
//
// Needs the registry (https://registry.npmjs.org, or --registry) and a built tree:
//
//   node tools/ci/measure-qadam-divergence.mjs --build           # builds every official qadam first
//   node tools/ci/measure-qadam-divergence.mjs                   # the qadams are already built
//   node tools/ci/measure-qadam-divergence.mjs --json            # machine-readable
//   node tools/ci/measure-qadam-divergence.mjs --qadams slack,csv    # a subset, by short or full name
//
//   --root <dir>          the repository (default: the current directory)
//   --registry <url>      default https://registry.npmjs.org
//   --concurrency <n>     parallel registry reads (default 8)
//   --declarations        also compare the .d.ts files
//   --max-attempts <n>    tries per registry read (default 4); --retry-base-ms <n> the first backoff (default 1000)
//   --build               run `npx turbo run build --filter='@aiqadam/qadam-*'` in --root first (its output goes
//                         to stderr, so --json on stdout stays parseable)
//
// Needs `semver` from node_modules, so it runs after `bun install`.
//
// Exit: 0 measured (divergences or not — the count is the answer), 2 UNKNOWN (a qadam could not be
// measured: registry unreachable, tree not built, a changeset that does not parse, a --qadams name
// that matches no 0.x qadam, bad arguments). Never a quiet 0 for a partial measurement.
//
// Tested by tools/ci/test-qadam-divergence.sh.
import { execFileSync } from 'node:child_process'
import { qadamDivergence } from './qadam-divergence.mjs'

const main = async () => {
  const argv = process.argv.slice(2)
  const common = qadamDivergence.readCommonOptions({ argv })
  const qadamsIndex = argv.indexOf('--qadams')
  const qadamsValue = qadamsIndex === -1 ? '' : argv[qadamsIndex + 1]
  if (common.error || qadamsValue === undefined || qadamsValue.startsWith('--')) {
    return unknown({ message: common.error ?? '--qadams needs a value' })
  }
  const { root, registry, concurrency, declarations, maxAttempts, retryBaseMs } = common.options

  if (argv.includes('--build')) {
    console.error('[measure-qadam-divergence] building every official qadam (npx turbo run build --filter=@aiqadam/qadam-*) ...')
    // turbo's stdout goes to stderr: this script's own stdout is the report, and `--json` must parse.
    execFileSync('npx', ['turbo', 'run', 'build', '--filter=@aiqadam/qadam-*'], { cwd: root, stdio: ['ignore', 2, 2] })
  }

  const wanted = qadamsValue.split(',').filter(Boolean).map((name) => (name.startsWith('@') ? name : `@aiqadam/qadam-${name}`))
  const zeroX = qadamDivergence.listQadams({ root }).filter(qadamDivergence.isZeroX)
  const unmatched = wanted.filter((name) => !zeroX.some((qadam) => qadam.name === name))
  if (unmatched.length > 0) {
    return unknown({ message: `--qadams names no 0.x qadam under packages/qadams/{core,community} for: ${unmatched.map((name) => qadamDivergence.sanitize({ text: name })).join(', ')}` })
  }
  const qadams = wanted.length === 0 ? zeroX : zeroX.filter((qadam) => wanted.includes(qadam.name))
  if (qadams.length === 0) {
    return unknown({ message: `no 0.x qadams under packages/qadams/{core,community} in ${root}` })
  }
  const { changesets, problems } = qadamDivergence.readChangesets({ root })
  if (problems.length > 0) {
    return unknown({ message: `a changeset does not parse, so which qadams it covers is unknown: ${problems.join(' | ')}` })
  }

  const results = await qadamDivergence.measureQadams({ qadams, registry, concurrency, declarations, maxAttempts, retryBaseMs })
  const classified = qadamDivergence.classify({ results, changesets })
  if (argv.includes('--json')) {
    printJson({ results, classified, registry })
  }
  else {
    printText({ results, classified, registry })
  }
  if (classified.unknown.length > 0) {
    process.exitCode = 2
  }
}

const unknown = ({ message }) => {
  console.error(`[measure-qadam-divergence] UNKNOWN — ${message}.`)
  process.exitCode = 2
}

const printJson = ({ results, classified, registry }) => {
  console.log(JSON.stringify({
    registry,
    measured: results.length,
    divergent: classified.divergent.length,
    unpublished: classified.unpublished.length,
    unknown: classified.unknown.length,
    results: results.map(({ name, version, status, differences, reason }) => ({
      name,
      version,
      status,
      differences,
      ...(reason === undefined ? {} : { reason }),
      ...(status === 'divergent' ? { pendingChangeset: classified.levelOf(name) } : {}),
    })),
  }, null, 2))
}

const printText = ({ results, classified, registry }) => {
  const { divergent, covered, unpublished, unknown: unmeasured } = classified
  console.log(`[measure-qadam-divergence] ${results.length} 0.x qadam(s) measured against ${registry}:`)
  console.log(`  identical to npm   ${classified.identical.length}`)
  console.log(`  DIVERGENT          ${divergent.length}   (${covered.length} already have a pending changeset, ${divergent.length - covered.length} do not)`)
  console.log(`  not on npm         ${unpublished.length}`)
  console.log(`  skipped            ${classified.skipped.length}`)
  console.log(`  could not measure  ${unmeasured.length}`)
  if (divergent.length > 0) {
    console.log('\nDivergent (tree build differs from npm under the same version):')
    for (const result of divergent) {
      console.log(`  ${result.name}@${result.version}${classified.levelOf(result.name) === null ? '' : '  [pending changeset]'}`)
      for (const difference of result.differences) {
        console.log(`      ${difference}`)
      }
    }
  }
  if (unpublished.length > 0) {
    console.log('\nNot on npm under the tree version (nothing to compare with; not counted as divergent):')
    for (const result of unpublished) {
      console.log(`  ${result.name}@${result.version}`)
    }
  }
  if (unmeasured.length > 0) {
    console.error('\nUNKNOWN — these could not be measured, so the count above is incomplete:')
    for (const result of unmeasured) {
      console.error(`  ${result.name}@${result.version}: ${result.reason}`)
    }
  }
}

main().catch((error) => {
  console.error(`[measure-qadam-divergence] UNKNOWN — ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 2
})
