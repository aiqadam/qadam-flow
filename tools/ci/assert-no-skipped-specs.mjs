#!/usr/bin/env node
//
// A skipped spec must not pass unnoticed (#342, #337's third box): Playwright exits 0 whether a
// test passed or was `test.skip()`-ed, so a green phase proves nothing about the specs in it
// unless something also checks the report's contents. This walks a Playwright JSON reporter report
// and fails if anything skipped, or if a required test title never ran at all.
//
// `--ignore-skip <title substring>` (repeatable) exists for #337's chat phase specifically:
// `chat-real-provider.spec.ts` skips whenever `E2E_REAL_AI_API_KEY` is unset, which is true for
// every CI run (the key is not something to spend money on per push) — a real, permanent skip that
// must not fail the job, unlike every other spec in that phase. Without this, the only way to
// reuse this same gate for the chat phase would be a second, narrower Playwright invocation just
// for the assertion — which would run the stub-driven specs twice.
//
// Usage:
//   node tools/ci/assert-no-skipped-specs.mjs <report.json> \
//     [--ignore-skip "title substring" ...] ["required title substring" ...]
//
import fs from 'node:fs'

const main = () => {
  const [reportPath, ...rest] = process.argv.slice(2)
  if (!reportPath) {
    console.error(
      'usage: assert-no-skipped-specs.mjs <report.json> [--ignore-skip "title substring" ...] ["required title substring" ...]',
    )
    process.exit(1)
  }

  const { requiredSubstrings, ignoreSkipSubstrings } = parseArgs(rest)

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  const specs = collectSpecs(report.suites ?? [])

  if (specs.length === 0) {
    console.error(`${reportPath} contains zero specs — that is a broken report, not an empty pass.`)
    process.exit(1)
  }

  const skipped = specs
    .filter((spec) => spec.tests.some((test) => test.status === 'skipped'))
    .filter((spec) => !ignoreSkipSubstrings.some((substring) => spec.title.includes(substring)))
  if (skipped.length > 0) {
    console.error('The following specs skipped instead of running for real:')
    for (const spec of skipped) {
      console.error(`  - ${spec.title}`)
    }
    process.exit(1)
  }

  const missing = requiredSubstrings.filter((substring) => !specs.some((spec) => spec.title.includes(substring)))
  if (missing.length > 0) {
    console.error('The following required specs did not run at all in this report:')
    for (const substring of missing) {
      console.error(`  - (title containing) "${substring}"`)
    }
    process.exit(1)
  }

  const ignoredSkipCount = specs.filter((spec) =>
    spec.tests.some((test) => test.status === 'skipped') &&
    ignoreSkipSubstrings.some((substring) => spec.title.includes(substring)),
  ).length
  const ignoredNote = ignoredSkipCount > 0 ? ` (${ignoredSkipCount} expected skip(s) ignored: ${ignoreSkipSubstrings.join(', ')})` : ''
  console.log(`${specs.length} spec(s) ran, none skipped unexpectedly${ignoredNote}.${requiredSubstrings.length ? ` Confirmed present: ${requiredSubstrings.join(', ')}` : ''}`)
}

const parseArgs = (args) => {
  const requiredSubstrings = []
  const ignoreSkipSubstrings = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--ignore-skip') {
      i += 1
      if (i >= args.length) {
        console.error('--ignore-skip requires a title substring argument')
        process.exit(1)
      }
      ignoreSkipSubstrings.push(args[i])
    } else {
      requiredSubstrings.push(args[i])
    }
  }
  return { requiredSubstrings, ignoreSkipSubstrings }
}

const collectSpecs = (suites) => {
  const specs = []
  for (const suite of suites) {
    specs.push(...(suite.specs ?? []))
    specs.push(...collectSpecs(suite.suites ?? []))
  }
  return specs
}

main()
