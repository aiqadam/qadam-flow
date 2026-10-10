// The release archive as the image assembly sees it (ADR-0003 #804, ADR-0004 "Image assembly").
//
// A release archives the artifacts it built and never rebuilds them from git (#476). Its shape is
// what `build-qadam-artifacts.mjs --pack` writes: `archive-index.json` plus the `npm pack` tarballs.
// Whether such an archive exists at release time is #804's remaining work, so today nothing passes
// one and `unavailable` is what every caller gets; the plan then takes ADR-0004's fallback. When the
// release pipeline archives, pointing `--archive` at the directory is the whole switch.
//
// Node builtins only.
import fs from 'node:fs'
import path from 'node:path'

export const ARCHIVE_INDEX_FILE = 'archive-index.json'

export const releaseArchive = {
  // No archive: nothing is configured, or it cannot be read. `reason` goes into the warning.
  unavailable: ({ reason }) => ({ available: false, reason, dir: null, find: () => null }),

  // The directory `--pack` wrote. An index that cannot be read is an unavailable archive, never a
  // partial one. An entry whose tarball is missing is simply not found: in a build from `main` the
  // package it names falls back to a snapshot, and in a release build the plan fails.
  fromDirectory: ({ dir }) => {
    const index = readIndex({ dir })
    if (!index.ok) {
      return releaseArchive.unavailable({ reason: index.reason })
    }
    const entries = new Map(index.artifacts.map((artifact) => [key({ name: artifact.name, version: artifact.version }), artifact]))
    return {
      available: true,
      reason: null,
      dir,
      find: ({ name, version }) => {
        const entry = entries.get(key({ name, version }))
        return entry !== undefined && isFile({ file: path.join(dir, entry.file) }) ? entry : null
      },
    }
  },
}

// A plain file name inside the archive directory; `npm pack` names scoped packages `scope-name-1.2.3.tgz`.
const TARBALL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/

// An index with anything wrong in it is not an archive: dropping the bad entry would make the
// qadam it named look "not archived", and a release build would then rebuild it from git. Every
// problem makes the whole archive unavailable, with the reason.
const readIndex = ({ dir }) => {
  const file = path.join(dir, ARCHIVE_INDEX_FILE)
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch (error) {
    return { ok: false, reason: `${file} cannot be read as JSON (${error?.code ?? error?.message})` }
  }
  if (parsed?.formatVersion !== 1 || !Array.isArray(parsed.artifacts)) {
    return { ok: false, reason: `${file} is not a version-1 archive index` }
  }
  const malformed = parsed.artifacts.findIndex((artifact) => !isArtifact({ artifact }))
  if (malformed !== -1) {
    return { ok: false, reason: `${file} entry ${malformed} (${describe({ artifact: parsed.artifacts[malformed] })}) is not { name, version, integrity, file } with a plain .tgz file name` }
  }
  const keys = parsed.artifacts.map((artifact) => key({ name: artifact.name, version: artifact.version }))
  const duplicate = keys.find((candidate, index) => keys.indexOf(candidate) !== index)
  if (duplicate !== undefined) {
    return { ok: false, reason: `${file} lists ${duplicate} twice` }
  }
  return { ok: true, artifacts: parsed.artifacts }
}

const isArtifact = ({ artifact }) => {
  return typeof artifact?.name === 'string'
    && typeof artifact.version === 'string'
    && typeof artifact.integrity === 'string'
    && typeof artifact.file === 'string'
    && TARBALL_FILE_NAME.test(artifact.file)
}

const describe = ({ artifact }) => (typeof artifact?.name === 'string' ? `${artifact.name}@${artifact.version}` : JSON.stringify(artifact)?.slice(0, 80))

const isFile = ({ file }) => {
  try {
    return fs.statSync(file).isFile()
  }
  catch {
    return false
  }
}

const key = ({ name, version }) => `${name}@${version}`
