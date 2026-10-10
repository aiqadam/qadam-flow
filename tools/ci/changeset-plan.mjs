// What the pending changesets of a tree plan for each package, and nothing more (ADR-0004, #851).
//
// `levels` holds each package's OWN level: the highest one any pending `.changeset/*.md` declares
// for that package by name. It deliberately leaves out what `changeset version` adds on top, the
// patch bumps of workspace dependents (`updateInternalDependencies`): in a build from `main` a
// package that is only raised as a dependent keeps its released number and artifact, and gets its
// new version at the release (ADR-0004, "A qadam gets a snapshot only for its own changeset").
// Reading the plan through `changeset status` would fold the two together and could not tell them
// apart again.
//
// `ok: false` is "the plan is unavailable": the tree holds something this reader does not model
// (changesets pre mode), or a changeset it cannot read. The caller then falls back instead of
// guessing, which for a build from `main` means building every package as a snapshot.
//
// Node builtins only, on top of the self-contained check-changesets.mjs, so CI reads it without an
// install. Used by compute-main-version.mjs and tools/scripts/qadams/snapshot/.
import fs from 'node:fs'
import path from 'node:path'
import { changesetGate } from './check-changesets.mjs'

const CHANGESET_DIR = '.changeset'

export const changesetPlan = {
  // `names`: the packages the caller reads a level for. One of them in a fixed or linked group of
  // `.changeset/config.json` makes the plan unavailable: the release would then raise it with the
  // group, and its own changesets alone are no longer its plan.
  read: (...args) => read(...args),
}

const read = ({ root, names = [] }) => {
  const changesetDir = path.join(root, CHANGESET_DIR)
  if (fs.existsSync(path.join(changesetDir, 'pre.json'))) {
    return { ok: false, error: `${CHANGESET_DIR}/pre.json exists: changesets pre mode versions differently and this reader does not model it` }
  }
  const config = readJson({ file: path.join(changesetDir, 'config.json') })
  if (config === null) {
    return { ok: false, error: `${CHANGESET_DIR}/config.json is missing or not JSON` }
  }
  const grouped = [...(config.fixed ?? []), ...(config.linked ?? [])].flatMap((group) => (Array.isArray(group) ? group : [])).find((member) => names.includes(member))
  if (grouped !== undefined) {
    return { ok: false, error: `${CHANGESET_DIR}/config.json puts ${grouped} in a fixed/linked group; the release plan is then not its own changesets alone` }
  }
  const files = listChangesetFiles({ changesetDir })
  if (files === null) {
    return { ok: false, error: `${CHANGESET_DIR} cannot be read` }
  }
  const changesets = files.map((file) => readChangeset({ changesetDir, file }))
  const broken = changesets.find((changeset) => changeset.problems.length > 0)
  if (broken) {
    return { ok: false, error: `${CHANGESET_DIR}/${broken.name}: ${broken.problems.join('; ')}` }
  }
  return { ok: true, config, changesets, levels: Object.fromEntries(changesetGate.declaredLevels({ changesets })) }
}

// A changeset that cannot be read is a problem of its own, named, not an exception: the plan is
// then unavailable and the build falls back.
const readChangeset = ({ changesetDir, file }) => {
  try {
    return { name: file, ...changesetGate.parseChangeset({ text: fs.readFileSync(path.join(changesetDir, file), 'utf8') }) }
  }
  catch (error) {
    return { name: file, releases: [], summary: '', problems: [`cannot be read (${error?.code ?? error?.message})`] }
  }
}

const listChangesetFiles = ({ changesetDir }) => {
  try {
    return fs.readdirSync(changesetDir).filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md').sort()
  }
  catch {
    return null
  }
}

const readJson = ({ file }) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }
  catch {
    return null
  }
}
