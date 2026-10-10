// Builds ADR-0003 artifacts (#804) for official qadams, in build-only mode: nothing is published
// and no qadam version changes. Writes `<out>/report.json` and prints a summary.
//
//   node tools/scripts/qadams/bundle/build-qadam-artifacts.mjs --out /tmp/qadam-artifacts --qadams csv,crypto
//   node tools/scripts/qadams/bundle/build-qadam-artifacts.mjs --out /tmp/qadam-artifacts --all --concurrency 2
//
// Options:
//   --out <dir>          artifact root; laid out as the store would be: `<out>/<name>/<version>/`
//   --qadams <a,b>       directory names (`csv`) or package names (`@aiqadam/qadam-csv`)
//   --all                every official qadam (`packages/qadams/{core,community}`)
//   --concurrency <n>    qadams built at once (default 2)
//   --no-load-check      skip loading each artifact; no `metadata.json` is written, so the
//                        result is for inspecting bundles only, not a releasable artifact
//   --pack               `npm pack` each loaded artifact into `<out>/archive/` and write
//                        `<out>/archive/archive-index.json` (name, version, integrity, commit)
//   --allow-failures     exit 0 even when some qadams failed (for a survey of the catalogue)
//   --snapshot-plan <f>  build each qadam at the version the plan gives it (ADR-0004, #851): a
//                        `-main.<n>` snapshot is written into the artifact's package.json and
//                        metadata.json, and the artifact is stored under that version. A qadam the
//                        plan takes from the release archive is not built; with `--pack` its archived
//                        tarball is copied into `<out>/archive/` and listed in the same index.
//                        Made by tools/scripts/qadams/snapshot/compute-snapshot-plan.mjs.
//   --release-archive <d>  the directory the archived tarballs come from: what an earlier release's
//                        `--pack` wrote (`archive-index.json` and the tarballs). Needed only when the
//                        plan takes a qadam from the archive, and then `--pack` is too.
//   --config <file>      per-qadam exceptions (default: qadam-artifact-config.json beside this)
//
// `--out` must not sit inside the repository: the load check resolves `@aiqadam/*` and `zod`
// upward from each artifact, and a workspace `node_modules` above it would answer instead of the
// platform copy provisioned in `<out>/node_modules`.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseArchive } from '../snapshot/release-archive.mjs'
import { SNAPSHOT_ORIGIN, snapshotPlan } from '../snapshot/snapshot-plan.mjs'
import { ARTIFACT_STATUS, qadamArtifact } from './qadam-artifact.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const DEFAULT_CONFIG_PATH = join(import.meta.dirname, 'qadam-artifact-config.json')

const main = async () => {
    const { values } = parseArgs({
        options: {
            out: { type: 'string' },
            qadams: { type: 'string' },
            all: { type: 'boolean', default: false },
            concurrency: { type: 'string', default: '2' },
            'no-load-check': { type: 'boolean', default: false },
            pack: { type: 'boolean', default: false },
            'allow-failures': { type: 'boolean', default: false },
            config: { type: 'string', default: DEFAULT_CONFIG_PATH },
            'snapshot-plan': { type: 'string' },
            'release-archive': { type: 'string' },
        },
    })
    if (!values.out || (!values.all && !values.qadams)) {
        console.error('usage: build-qadam-artifacts.mjs --out <dir> (--all | --qadams <a,b>) [--concurrency n] [--no-load-check] [--pack] [--allow-failures] [--config file] [--snapshot-plan file [--release-archive dir]]')
        process.exit(2)
    }
    const outRoot = resolve(values.out)
    if ((outRoot + sep).startsWith(REPO_ROOT + sep)) {
        console.error(`--out must be outside the repository (${REPO_ROOT}); see the header of this script`)
        process.exit(2)
    }
    const loadCheck = !values['no-load-check']
    const concurrency = Math.max(1, Number.parseInt(values.concurrency, 10) || 1)
    const config = JSON.parse(await readFile(resolve(values.config), 'utf8'))
    const allQadams = await findOfficialQadams()
    const selected = values.all ? allQadams : selectQadams({ allQadams, wanted: values.qadams.split(',').map((q) => q.trim()).filter(Boolean) })

    if (values['release-archive'] !== undefined && values['snapshot-plan'] === undefined) {
        console.error('--release-archive only applies with --snapshot-plan: the plan says which qadams come from it')
        process.exit(2)
    }
    const snapshot = values['snapshot-plan'] === undefined
        ? null
        : await readSnapshotPlan({ file: resolve(values['snapshot-plan']), selected, archiveDir: values['release-archive'], pack: values.pack, loadCheck })

    await mkdir(outRoot, { recursive: true })
    const host = loadCheck ? await qadamArtifact.provisionHost({ outRoot, repoRoot: REPO_ROOT }) : null
    const builtAgainst = await qadamArtifact.readBuiltAgainst({ repoRoot: REPO_ROOT, platformVersion: snapshot?.platformVersion })
    const packDestination = join(outRoot, 'archive')
    const startedAt = Date.now()
    const results = await runPool({
        items: selected,
        concurrency,
        worker: async ({ qadam, index }) => {
            const entry = snapshot?.find({ name: qadam.packageName }) ?? null
            const build = entry?.origin === SNAPSHOT_ORIGIN.ARCHIVE
                ? takeFromArchive({ archive: snapshot.archive, entry, source: relative(REPO_ROOT, qadam.dir), packDestination })
                : qadamArtifact.build({
                    qadamDir: qadam.dir,
                    outRoot,
                    repoRoot: REPO_ROOT,
                    config,
                    loadCheck,
                    pack: values.pack && loadCheck,
                    packDestination,
                    version: entry?.version,
                    builtAgainst,
                })
            const result = await build.catch((e) => ({ name: qadam.packageName, version: null, source: relative(REPO_ROOT, qadam.dir), status: ARTIFACT_STATUS.BUILD_ERROR, error: String(e?.message ?? e), durationMs: 0 }))
            console.info(`[${index + 1}/${selected.length}] ${result.name}@${result.version} ${result.status} ${result.kind ?? ''} ${result.durationMs}ms${result.error ? ` — ${result.error}` : ''}`)
            return result
        },
    })
    const commit = gitCommit()
    const report = {
        generatedAt: new Date().toISOString(),
        commit,
        node: process.versions.node,
        platform: `${process.platform}-${process.arch}`,
        loadCheck,
        host: host === null ? null : Object.fromEntries(Object.entries(host).map(([name, path]) => [name, relative(REPO_ROOT, path)])),
        durationMs: Date.now() - startedAt,
        summary: summarize({ results }),
        results,
    }
    await writeFile(join(outRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n')
    if (values.pack && loadCheck) {
        await writeArchiveIndex({ results, packDestination, commit })
    }
    printSummary({ report, outRoot })
    const failed = results.filter(isFailure).length
    process.exit(failed > 0 && !values['allow-failures'] ? 1 : 0)
}

// What a release archives (#804, #476: release artifacts are archived when built and never
// rebuilt from git). The tarball is the file npm would receive; the index pins its integrity to
// the commit it was built from, so a later rebuild can be told apart from the archived original.
const writeArchiveIndex = async ({ results, packDestination, commit }) => {
    const entries = results.filter((r) => r.tarball).map((r) => ({
        name: r.name,
        version: r.version,
        kind: r.kind,
        file: r.tarball.file,
        integrity: r.tarball.integrity,
        shasum: r.tarball.shasum,
        size: r.tarball.size,
        // An archived release keeps the commit it was built from, not this build's.
        commit: r.commit ?? commit,
    }))
    // `--pack --allow-failures` can reach here with no tarball at all; the index is still written.
    await mkdir(packDestination, { recursive: true })
    await writeFile(join(packDestination, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts: entries }, null, 2) + '\n')
}

const isFailure = (result) => result.status !== ARTIFACT_STATUS.OK && result.status !== ARTIFACT_STATUS.FROM_ARCHIVE

// The plan the artifact versions come from (ADR-0004, #851). Every selected qadam must be in it, at
// the released version this tree holds: a qadam built at a version nobody planned, or from a plan
// made at another commit, is exactly what the plan exists to prevent.
const readSnapshotPlan = async ({ file, selected, archiveDir, pack, loadCheck }) => {
    const text = await readFile(file, 'utf8').catch((error) => {
        console.error(`--snapshot-plan ${file} cannot be read (${error?.code ?? error?.message})`)
        return process.exit(2)
    })
    const parsed = snapshotPlan.parse({ text })
    if (!parsed.ok) {
        console.error(`--snapshot-plan ${file}: ${parsed.error}`)
        process.exit(2)
    }
    const missing = selected.filter((qadam) => parsed.find({ name: qadam.packageName }) === null)
    if (missing.length > 0) {
        console.error(`not in the snapshot plan: ${missing.map((qadam) => qadam.packageName).join(', ')}`)
        process.exit(2)
    }
    const stale = selected.filter((qadam) => parsed.find({ name: qadam.packageName }).released !== qadam.version)
    if (stale.length > 0) {
        console.error(`the snapshot plan was made for other versions of this tree: ${stale.map((qadam) => `${qadam.packageName} is ${qadam.version}, the plan says ${parsed.find({ name: qadam.packageName }).released}`).join('; ')}`)
        process.exit(2)
    }
    const archived = selected.filter((qadam) => parsed.find({ name: qadam.packageName }).origin === SNAPSHOT_ORIGIN.ARCHIVE)
    if (archived.length > 0 && archiveDir === undefined) {
        console.error(`the plan takes ${archived.length} qadam(s) from the release archive (${archived.map((qadam) => qadam.packageName).join(', ')}): pass --release-archive <dir>`)
        process.exit(2)
    }
    if (archived.length > 0 && !(pack && loadCheck)) {
        console.error(`the plan takes ${archived.length} qadam(s) from the release archive: it is copied into the archive that --pack writes, so pass --pack and not --no-load-check (a build without the load check writes no archive)`)
        process.exit(2)
    }
    return {
        find: parsed.find,
        platformVersion: parsed.plan.platformVersion ?? undefined,
        archive: archiveDir === undefined ? null : releaseArchive.fromDirectory({ dir: resolve(archiveDir) }),
    }
}

// The seam for ADR-0004's "unchanged bundle-format qadams come from the release archive": the
// archived tarball is the artifact, so it is verified against the integrity its index recorded and
// copied as it is, never rebuilt.
const takeFromArchive = async ({ archive, entry, source, packDestination }) => {
    const base = { name: entry.name, version: entry.version, source, durationMs: 0 }
    const archived = archive?.find({ name: entry.name, version: entry.version }) ?? null
    if (archived === null) {
        const why = archive?.available === false ? ` (${archive.reason})` : ''
        return { ...base, status: ARTIFACT_STATUS.BUILD_ERROR, error: `the release archive has no ${entry.name}@${entry.version}${why}` }
    }
    const bytes = await readFile(join(archive.dir, archived.file))
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    if (integrity !== archived.integrity) {
        return { ...base, status: ARTIFACT_STATUS.BUILD_ERROR, error: `${archived.file} does not match the integrity its archive index records` }
    }
    // The bytes that were hashed are the bytes written: a second read of the file could be another file.
    await mkdir(packDestination, { recursive: true })
    await writeFile(join(packDestination, archived.file), bytes)
    return {
        ...base,
        status: ARTIFACT_STATUS.FROM_ARCHIVE,
        kind: archived.kind ?? null,
        commit: archived.commit,
        tarball: { file: archived.file, integrity, shasum: archived.shasum, size: bytes.length },
    }
}

// The set the plan covers, from the same discovery, so the two cannot disagree on what is official.
const findOfficialQadams = async () => {
    const discovered = snapshotPlan.discover({ root: REPO_ROOT })
    if (!discovered.ok) {
        console.error(discovered.error)
        process.exit(2)
    }
    return discovered.packages.map((pkg) => ({ dir: join(REPO_ROOT, pkg.directory), directoryName: basename(pkg.directory), packageName: pkg.name, version: pkg.version }))
}

const selectQadams = ({ allQadams, wanted }) => {
    const missing = wanted.filter((w) => !allQadams.some((q) => q.directoryName === w || q.packageName === w))
    if (missing.length > 0) {
        console.error(`unknown qadams: ${missing.join(', ')}`)
        process.exit(2)
    }
    return allQadams.filter((q) => wanted.includes(q.directoryName) || wanted.includes(q.packageName))
}

const runPool = async ({ items, concurrency, worker }) => {
    const results = new Array(items.length)
    const cursor = { next: 0 }
    const lane = async () => {
        while (cursor.next < items.length) {
            const index = cursor.next++
            results[index] = await worker({ qadam: items[index], index })
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
    return results
}

const summarize = ({ results }) => {
    const byStatus = countBy({ values: results.map((r) => r.status) })
    const ok = results.filter((r) => r.status === ARTIFACT_STATUS.OK)
    const bundleSizes = ok.map((r) => r.sizes.bundleBytes).sort((a, b) => a - b)
    return {
        total: results.length,
        byStatus,
        byKind: countBy({ values: ok.map((r) => r.kind) }),
        withI18n: ok.filter((r) => r.i18nLocales.length > 0).length,
        withRuntimeFileRisk: results.filter((r) => (r.runtimeFileRisk ?? []).length > 0).length,
        withUnresolvedOptional: results.filter((r) => (r.unresolvedOptional ?? []).length > 0).length,
        bundleBytes: bundleSizes.length === 0 ? null : {
            total: bundleSizes.reduce((sum, size) => sum + size, 0),
            median: bundleSizes[bundleSizes.length >> 1],
            max: bundleSizes.at(-1),
        },
    }
}

const printSummary = ({ report, outRoot }) => {
    const { summary, results } = report
    console.info(`\n${summary.total} qadams in ${(report.durationMs / 1000).toFixed(0)} s — ${JSON.stringify(summary.byStatus)}; kinds ${JSON.stringify(summary.byKind)}; with i18n ${summary.withI18n}`)
    results.filter(isFailure).forEach((r) => console.info(`  ${r.status.padEnd(18)} ${r.name}@${r.version}: ${r.error}`))
    console.info(`report: ${join(outRoot, 'report.json')}`)
}

const countBy = ({ values }) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {})

const gitCommit = () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages/qadams'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== ''
    return { sha, dirtyQadams: dirty }
}

await main()
