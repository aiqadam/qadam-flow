#!/usr/bin/env node
//
// A skipped spec must not pass unnoticed (#342, #337's third box): Playwright exits 0 whether a
// test passed or was `test.skip()`-ed, so a green "@smtp" phase proves nothing about the mail
// specs unless something also checks the report's contents. This walks a Playwright JSON reporter
// report and fails if anything skipped, or if a required test title never ran at all.
//
// Usage:
//   node tools/ci/assert-no-skipped-specs.mjs <report.json> ["required title substring" ...]
//
import fs from 'node:fs'

const main = () => {
  const [reportPath, ...requiredSubstrings] = process.argv.slice(2)
  if (!reportPath) {
    console.error('usage: assert-no-skipped-specs.mjs <report.json> ["required title substring" ...]')
    process.exit(1)
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
  const specs = collectSpecs(report.suites ?? [])

  if (specs.length === 0) {
    console.error(`${reportPath} contains zero specs — that is a broken report, not an empty pass.`)
    process.exit(1)
  }

  const skipped = specs.filter((spec) => spec.tests.some((test) => test.status === 'skipped'))
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

  console.log(`${specs.length} spec(s) ran, none skipped.${requiredSubstrings.length ? ` Confirmed present: ${requiredSubstrings.join(', ')}` : ''}`)
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
