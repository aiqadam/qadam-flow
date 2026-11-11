// Turns the full #804 archive into the seed an image ships (ADR-0003, #807).
//
// The image builds every official qadam once into one shared archive, because `--pack`ing a
// single pass is simpler than a per-flavour build, but `:slim` seeds the store with the 27 core
// qadams only. The archive is the input of record — this never rebuilds or re-derives a tarball,
// it copies the files the index names and writes the filtered index beside them.
//
//   node tools/scripts/qadams/bundle/build-image-seed.mjs \
//       --archive /tmp/qadam-artifacts/archive --out packages/qadams/version-store-seed --flavour slim
//
// Options:
//   --archive <dir>   `build-qadam-artifacts.mjs --pack` output: `archive-index.json` + tarballs
//   --out <dir>       seed directory to write: `archive-index.json` + the flavour's tarballs
//   --flavour <name>  `fat` (every official qadam) or `slim` (packages/qadams/core only)
//   --repo <dir>      repository root (default: the current directory)

import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'

const INDEX_FILE = 'archive-index.json'
const TARBALL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/
const CORE_DIR = path.join('packages', 'qadams', 'core')

const main = async () => {
    const { values } = parseArgs({
        options: {
            archive: { type: 'string' },
            out: { type: 'string' },
            flavour: { type: 'string' },
            repo: { type: 'string', default: process.cwd() },
        },
    })
    if (values.archive === undefined || values.out === undefined || (values.flavour !== 'fat' && values.flavour !== 'slim')) {
        console.error('usage: build-image-seed.mjs --archive <dir> --out <dir> (--flavour fat|slim) [--repo <dir>]')
        process.exit(2)
    }

    const repoRoot = path.resolve(values.repo)
    const archiveDir = path.resolve(values.archive)
    const outDir = path.resolve(values.out)
    const index = await readArchiveIndex({ archiveDir })
    const selected = values.flavour === 'fat'
        ? index.artifacts
        : await selectCore({ artifacts: index.artifacts, repoRoot })
    // Only the artifacts this flavour actually ships pay the stat() cost, and only their shape and
    // tarball presence gate the build — `slim` no longer fails over a community tarball it was
    // never going to copy (advisory review, #807).
    await Promise.all(selected.map((artifact) => validateArtifact({ artifact, archiveDir, indexPath: path.join(archiveDir, INDEX_FILE) })))

    try {
        await rm(outDir, { recursive: true, force: true })
        await mkdir(outDir, { recursive: true })
        await Promise.all(selected.map((artifact) => copyFile(path.join(archiveDir, artifact.file), path.join(outDir, artifact.file))))
        await writeFile(path.join(outDir, INDEX_FILE), `${JSON.stringify({ formatVersion: 1, artifacts: selected }, null, 2)}\n`)
    }
    catch (error) {
        fail(`cannot write the seed to ${outDir} (${error?.code ?? error?.message})`)
    }

    console.log(JSON.stringify({
        flavour: values.flavour,
        qadams: new Set(selected.map((artifact) => artifact.name)).size,
        artifacts: selected.length,
        seed: outDir,
    }))
}

const readArchiveIndex = async ({ archiveDir }) => {
    const indexPath = path.join(archiveDir, INDEX_FILE)
    let parsed
    try {
        parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    }
    catch (error) {
        fail(`cannot read ${indexPath} (${error?.code ?? error?.message})`)
    }
    if (parsed?.formatVersion !== 1 || !Array.isArray(parsed.artifacts)) {
        fail(`${indexPath} is not a version-1 archive index`)
    }
    return parsed
}

const validateArtifact = async ({ artifact, archiveDir, indexPath }) => {
    if (typeof artifact?.name !== 'string' || typeof artifact?.version !== 'string' || typeof artifact?.file !== 'string') {
        fail(`${indexPath} has an artifact without name, version or file`)
    }
    if (!TARBALL_FILE_NAME.test(artifact.file)) {
        fail(`${indexPath} names a tarball with a path-unsafe file name: ${artifact.file}`)
    }
    const tarball = path.join(archiveDir, artifact.file)
    if (!isInside({ root: archiveDir, target: tarball })) {
        fail(`${indexPath} names a tarball outside the archive directory: ${artifact.file}`)
    }
    const stats = await stat(tarball).catch(() => null)
    if (stats === null || !stats.isFile()) {
        fail(`${indexPath} names a tarball that is not in the archive: ${artifact.file}`)
    }
}

const selectCore = async ({ artifacts, repoRoot }) => {
    const coreNames = await readCoreQadamNames({ repoRoot })
    const selected = artifacts.filter((artifact) => coreNames.has(artifact.name))
    const selectedNames = new Set(selected.map((artifact) => artifact.name))
    const missing = [...coreNames].filter((name) => !selectedNames.has(name))
    if (missing.length > 0) {
        fail(`the archive is missing core qadam(s): ${missing.slice(0, 5).join(', ')}`)
    }
    return selected
}

const readCoreQadamNames = async ({ repoRoot }) => {
    const coreDir = path.join(repoRoot, CORE_DIR)
    const entries = await readdir(coreDir, { withFileTypes: true }).catch((error) => fail(`cannot list ${coreDir} (${error?.code ?? error?.message})`))
    const names = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => readCoreQadamName({ coreDir, entry })),
    )
    const nameSet = new Set(names)
    if (nameSet.size === 0) {
        fail(`no core qadams found under ${coreDir}`)
    }
    return nameSet
}

const readCoreQadamName = async ({ coreDir, entry }) => {
    const manifestPath = path.join(coreDir, entry.name, 'package.json')
    let manifest
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    }
    catch (error) {
        return fail(`cannot read ${manifestPath} (${error?.code ?? error?.message})`)
    }
    if (typeof manifest?.name !== 'string') {
        return fail(`${manifestPath} has no package name`)
    }
    return manifest.name
}

const isInside = ({ root, target }) => {
    const relative = path.relative(root, target)
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

const fail = (message) => {
    console.error(`build-image-seed: ${message}`)
    process.exit(1)
}

await main()
