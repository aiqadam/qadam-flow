#!/usr/bin/env node
//
// The release PR's version step (ADR-0001, #796). .github/workflows/changesets.yml passes this to
// changesets/action as `version-script`; run it by hand to preview a release PR.
//
//   1. `changeset version` — consumes .changeset/*.md, raises every named package (and, because
//      every internal dependency is `workspace:*`, which publishes as an exact pin, patches every
//      workspace dependent of a raised package), writes each package's CHANGELOG.md.
//   2. Copies `packages/platform`'s version into the root package.json. Changesets cannot version
//      the monorepo root (`package qadam-flow ... is not in the workspace`), so the platform level
//      is declared on `@aiqadam/platform` and lands in the root here. The root is what
//      `apVersionUtil.getCurrentRelease()` reads and what release.yml's version-tag-gate compares
//      the tag against; tools/ci/check-changesets.mjs fails any PR in which the two disagree.
//
// It never publishes and never tags. Tagging stays a maintainer action after the release PR is
// merged (`git tag v<root version>`), which is what starts release.yml and its gates.
//
//   node tools/scripts/changesets/version.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const changesetBin = process.env.CHANGESET_BIN ?? path.join(repoRoot, 'node_modules', '.bin', 'changeset')
const cwd = process.cwd()

const pending = fs.existsSync(path.join(cwd, '.changeset'))
  ? fs.readdirSync(path.join(cwd, '.changeset')).filter((file) => file.endsWith('.md') && file.toLowerCase() !== 'readme.md')
  : []
// `changeset version` exits 1 when there is nothing to release; that is not an error here.
if (pending.length > 0) {
  execFileSync(changesetBin, ['version'], { cwd, stdio: 'inherit' })
}
else {
  console.log('[changesets/version] no pending changesets')
}

const platformManifest = JSON.parse(fs.readFileSync(path.join(cwd, 'packages/platform/package.json'), 'utf8'))
const rootPath = path.join(cwd, 'package.json')
const rootManifest = JSON.parse(fs.readFileSync(rootPath, 'utf8'))
if (typeof platformManifest.version !== 'string') {
  throw new Error('packages/platform/package.json has no version')
}
if (rootManifest.version !== platformManifest.version) {
  console.log(`[changesets/version] platform ${rootManifest.version} -> ${platformManifest.version}: writing the root package.json`)
  fs.writeFileSync(rootPath, `${JSON.stringify({ ...rootManifest, version: platformManifest.version }, null, 2)}\n`)
}
else {
  console.log(`[changesets/version] platform stays ${rootManifest.version}`)
}
