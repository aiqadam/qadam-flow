#!/usr/bin/env node
//
// Writes the platform version a `main` image reports into the image's root package.json
// (ADR-0001 "The platform version", #798). The Dockerfile's run stage calls it with the
// PLATFORM_VERSION build arg, which ci.yml computes with tools/ci/compute-main-version.mjs.
//
// Why package.json and not an environment variable: `apVersionUtil.getCurrentRelease()` already
// reads `process.cwd()/package.json`, in the API and in the worker, and both containers run the
// same image — so they keep agreeing, which the app/worker version gate needs. An ENV would be one
// `.env` line away from an operator overriding what the build is.
//
// It only ever writes a prerelease of the `main` channel, `X.Y.Z-main.<n>`, and only one whose
// X.Y.Z is above the version the tree holds (the last release). So a build argument cannot make an
// image claim a release (`2.1.0`) or order itself below the release it was built after. An empty
// argument leaves package.json alone: local builds and release.yml (whose tag version-tag-gate
// already pins to package.json) report the tree's own version.
//
//   node tools/scripts/stamp-platform-version.mjs "<version or empty>" [path/to/package.json]
//
// Exit: 0 written or left alone, 1 refused. Node builtins only — the run stage has no tools/.
// Tested by tools/ci/test-main-version.sh.
import fs from 'node:fs'

const MAIN_PRERELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-main\.(0|[1-9]\d*)$/
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const main = () => {
  const [requested = '', manifestPath = 'package.json'] = process.argv.slice(2)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (requested === '') {
    console.log(`[stamp-platform-version] no version given; ${manifestPath} keeps ${manifest.version}`)
    return
  }
  const problem = refuse({ requested, current: manifest.version })
  if (problem !== null) {
    console.error(`[stamp-platform-version] refusing '${requested}': ${problem}`)
    process.exitCode = 1
    return
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: requested }, null, 2)}\n`)
  console.log(`[stamp-platform-version] ${manifestPath}: ${manifest.version} -> ${requested}`)
}

const refuse = ({ requested, current }) => {
  const wanted = MAIN_PRERELEASE.exec(requested)
  if (wanted === null) {
    return 'only a main-channel prerelease X.Y.Z-main.<n> may be stamped into an image'
  }
  const released = RELEASE.exec(current ?? '')
  if (released === null) {
    return `package.json holds '${current}', not the X.Y.Z last release a -main version is computed from`
  }
  const [a, b] = [wanted.slice(1, 4).map(Number), released.slice(1, 4).map(Number)]
  const index = [0, 1, 2].find((i) => a[i] !== b[i])
  if (index === undefined || a[index] < b[index]) {
    return `${a.join('.')} is not above the last release ${current}, so the image would order at or below a release it was built after`
  }
  return null
}

main()
