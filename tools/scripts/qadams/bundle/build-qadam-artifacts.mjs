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
//   --config <file>      per-qadam exceptions (default: qadam-artifact-config.json beside this)
//
// `--out` must not sit inside the repository: the load check resolves `@aiqadam/*` and `zod`
// upward from each artifact, and a workspace `node_modules` above it would answer instead of the
// platform copy provisioned in `<out>/node_modules`.

import { execFileSync } from 'node:child_process'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { ARTIFACT_STATUS, qadamArtifact } from './qadam-artifact.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..')
const OFFICIAL_QADAM_ROOTS = ['packages/qadams/core', 'packages/qadams/community']
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
        },
    })
    if (!values.out || (!values.all && !values.qadams)) {
        console.error('usage: build-qadam-artifacts.mjs --out <dir> (--all | --qadams <a,b>) [--concurrency n] [--no-load-check] [--pack] [--allow-failures] [--config file]')
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

    await mkdir(outRoot, { recursive: true })
    const host = loadCheck ? await qadamArtifact.provisionHost({ outRoot, repoRoot: REPO_ROOT }) : null
    const packDestination = join(outRoot, 'archive')
    const startedAt = Date.now()
    const results = await runPool({
        items: selected,
        concurrency,
        worker: async ({ qadam, index }) => {
            const result = await qadamArtifact.build({
                qadamDir: qadam.dir,
                outRoot,
                repoRoot: REPO_ROOT,
                config,
                loadCheck,
                pack: values.pack && loadCheck,
                packDestination,
            }).catch((e) => ({ name: qadam.packageName, version: null, source: relative(REPO_ROOT, qadam.dir), status: ARTIFACT_STATUS.BUILD_ERROR, error: String(e?.message ?? e), durationMs: 0 }))
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
    const failed = results.filter((r) => r.status !== ARTIFACT_STATUS.OK).length
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
        commit,
    }))
    // `--pack --allow-failures` can reach here with no tarball at all; the index is still written.
    await mkdir(packDestination, { recursive: true })
    await writeFile(join(packDestination, 'archive-index.json'), JSON.stringify({ formatVersion: 1, artifacts: entries }, null, 2) + '\n')
}

const findOfficialQadams = async () => {
    const perRoot = await Promise.all(OFFICIAL_QADAM_ROOTS.map(async (root) => {
        const entries = await readdir(join(REPO_ROOT, root), { withFileTypes: true })
        const dirs = await Promise.all(entries.filter((e) => e.isDirectory()).map(async (e) => {
            const dir = join(REPO_ROOT, root, e.name)
            const hasManifest = await stat(join(dir, 'package.json')).then(() => true, () => false)
            if (!hasManifest) {
                return null
            }
            const { name } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
            return { dir, directoryName: e.name, packageName: name }
        }))
        return dirs.filter(Boolean)
    }))
    return perRoot.flat().sort((a, b) => a.packageName.localeCompare(b.packageName))
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
    results.filter((r) => r.status !== ARTIFACT_STATUS.OK).forEach((r) => console.info(`  ${r.status.padEnd(18)} ${r.name}@${r.version}: ${r.error}`))
    console.info(`report: ${join(outRoot, 'report.json')}`)
}

const countBy = ({ values }) => values.reduce((counts, value) => ({ ...counts, [value]: (counts[value] ?? 0) + 1 }), {})

const gitCommit = () => {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'packages/qadams'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim() !== ''
    return { sha, dirtyQadams: dirty }
}

await main()
