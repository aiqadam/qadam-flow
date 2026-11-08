#!/usr/bin/env node
//
// Prints one `--filter=<name>` per qadam that depends on the Vercel AI SDK (`ai`, `@ai-sdk/*`,
// `ai-gateway-provider`, `@openrouter/ai-sdk-provider`), for `turbo run build` in the
// "Lint + unit test suite" job (#1027).
//
// Why a build and not the typecheck: qadams declare no `typecheck` script, and `turbo run test`
// builds only a package's dependencies (`^build`), so nothing on the required path ran `tsc` on
// `@aiqadam/qadam-ai`. When its AI SDK pins lag the platform's, `bun.lock` carries two
// `@ai-sdk/provider` copies that are not assignable to each other. #815, #871, #896 and #911 were
// caught by hand on the Renovate branch; #972 (→ #997) and #1025 were not, and the TS2322
// surfaced only in the Docker image build, after automerge had landed it on `main`. Building these
// qadams on every PR puts that failure on a required check.
//
// The list is computed rather than hard-coded so a second qadam that starts depending on the SDK
// is covered the day it does. An empty list is an error: a step that builds nothing passes, and
// would say nothing (see .agents/docs/verification-pitfalls.md).
//
// Node builtins only, like the other tools/ci checkers.
//
//   node tools/ci/ai-sdk-qadams.mjs [--root <repo root>]

import fs from 'node:fs'
import path from 'node:path'

const AI_SDK_PACKAGES = new Set(['ai', 'ai-gateway-provider', '@openrouter/ai-sdk-provider'])

const rootFlag = process.argv.indexOf('--root')
const repoRoot = rootFlag === -1 ? process.cwd() : path.resolve(process.argv[rootFlag + 1])
const qadamsDir = path.join(repoRoot, 'packages', 'qadams')

const names = listManifests({ dir: qadamsDir })
  .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
  .filter((manifest) => dependsOnAiSdk({ manifest }))
  .map((manifest) => manifest.name)
  .sort()

if (names.length === 0) {
  console.error(`ai-sdk-qadams: no qadam under ${qadamsDir} depends on the AI SDK. If that is now true, remove the build step that calls this script instead of letting it build nothing.`)
  process.exit(1)
}

console.log(names.map((name) => `--filter=${name}`).join(' '))

function listManifests({ dir }) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'dist') {
      return []
    }
    const child = path.join(dir, entry.name)
    const manifest = path.join(child, 'package.json')
    return fs.existsSync(manifest) ? [manifest] : listManifests({ dir: child })
  })
}

function dependsOnAiSdk({ manifest }) {
  const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }
  return Object.keys(deps).some((dep) => AI_SDK_PACKAGES.has(dep) || dep.startsWith('@ai-sdk/'))
}
