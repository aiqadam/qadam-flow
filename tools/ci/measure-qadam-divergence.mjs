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
//   --build               run `npx turbo run build --filter='@aiqadam/qadam-*'` in --root first
//
// Needs `semver` from node_modules, so it runs after `bun install`.
//
// Exit: 0 measured (divergences or not — the count is the answer), 2 UNKNOWN (a qadam could not be
// measured: registry unreachable, tree not built, bad arguments). Never a quiet 0 for a partial
// measurement.
//
// Tested by tools/ci/test-qadam-divergence.sh.
import { execFileSync } from 'node:child_process'
import { isZeroX, listQadams, measureQadams, readCommonOptions, readPendingReleases } from './qadam-divergence.mjs'

const main = async () => {
  const argv = process.argv.slice(2)
  const common = readCommonOptions({ argv })
  const qadamsIndex = argv.indexOf('--qadams')
  const qadamsValue = qadamsIndex === -1 ? '' : argv[qadamsIndex + 1]
  if (common.error || qadamsValue === undefined || qadamsValue.startsWith('--')) {
    console.error(`[measure-qadam-divergence] UNKNOWN — ${common.error ?? '--qadams needs a value'}.`)
    process.exitCode = 2
    return
  }
  const { root, registry, concurrency, declarations, maxAttempts, retryBaseMs } = common.options
  const json = argv.includes('--json')

  if (argv.includes('--build')) {
    console.error('[measure-qadam-divergence] building every official qadam (npx turbo run build --filter=@aiqadam/qadam-*) ...')
    execFileSync('npx', ['turbo', 'run', 'build', '--filter=@aiqadam/qadam-*'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] })
  }

  const wanted = new Set(qadamsValue.split(',').filter(Boolean).map((name) => (name.startsWith('@') ? name : `@aiqadam/qadam-${name}`)))
  const qadams = listQadams({ root }).filter(isZeroX).filter((qadam) => wanted.size === 0 || wanted.has(qadam.name))
  if (qadams.length === 0) {
    console.error(`[measure-qadam-divergence] UNKNOWN — no 0.x qadams under packages/qadams/{core,community} in ${root}${wanted.size > 0 ? ` matching ${[...wanted].join(', ')}` : ''}.`)
    process.exitCode = 2
    return
  }

  const results = await measureQadams({ qadams, registry, concurrency, declarations, maxAttempts, retryBaseMs })
  const pending = readPendingReleases({ root })
  const withChangeset = (result) => pending.has(result.name)
  const by = (status) => results.filter((result) => result.status === status)
  const divergent = by('divergent')
  const unknown = by('unknown')

  if (json) {
    console.log(JSON.stringify({
      registry,
      measured: results.length,
      divergent: divergent.length,
      unpublished: by('unpublished').length,
      unknown: unknown.length,
      results: results.map(({ name, version, status, differences, reason }) => ({
        name,
        version,
        status,
        differences,
        ...(reason === undefined ? {} : { reason }),
        ...(status === 'divergent' ? { pendingChangeset: pending.get(name) ?? null } : {}),
      })),
    }, null, 2))
  }
  else {
    print({ results, divergent, unknown, by, withChangeset, registry })
  }
  if (unknown.length > 0) {
    process.exitCode = 2
  }
}

const print = ({ results, divergent, unknown, by, withChangeset, registry }) => {
  const covered = divergent.filter(withChangeset).length
  console.log(`[measure-qadam-divergence] ${results.length} 0.x qadam(s) measured against ${registry}:`)
  console.log(`  identical to npm   ${by('identical').length}`)
  console.log(`  DIVERGENT          ${divergent.length}   (${covered} already have a pending changeset, ${divergent.length - covered} do not)`)
  console.log(`  not on npm         ${by('unpublished').length}`)
  console.log(`  skipped            ${by('skipped').length}`)
  console.log(`  could not measure  ${unknown.length}`)
  if (divergent.length > 0) {
    console.log('\nDivergent (tree build differs from npm under the same version):')
    for (const result of divergent) {
      console.log(`  ${result.name}@${result.version}${withChangeset(result) ? '  [pending changeset]' : ''}`)
      for (const difference of result.differences) {
        console.log(`      ${difference}`)
      }
    }
  }
  if (by('unpublished').length > 0) {
    console.log('\nNot on npm under the tree version (nothing to compare with; not counted as divergent):')
    for (const result of by('unpublished')) {
      console.log(`  ${result.name}@${result.version}`)
    }
  }
  if (unknown.length > 0) {
    console.error('\nUNKNOWN — these could not be measured, so the count above is incomplete:')
    for (const result of unknown) {
      console.error(`  ${result.name}@${result.version}: ${result.reason}`)
    }
  }
}

main().catch((error) => {
  console.error(`[measure-qadam-divergence] UNKNOWN — ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 2
})
