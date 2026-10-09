import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import semVer from 'semver'
import { z } from 'zod'
import {
    CatalogueEntries,
    QADAM_VERSION_CATALOGUE_INDEX_FILE,
    QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES,
    QADAM_VERSION_CATALOGUE_METADATA_DIR,
    QadamVersionCatalogueArtifactFormat,
    QadamVersionCatalogueArtifactKind,
    QadamVersionCatalogueEntry,
    qadamVersionCatalogueFormat,
} from './qadam-version-catalogue-format'

// Appends released qadam versions to a qadam version catalogue on disk (ADR-0003: "The release
// pipeline appends each new version's metadata to the catalogue"). Run by
// `scripts/append-qadam-version-catalogue.ts` on a checkout of the published catalogue.
//
// The input is #804's `--pack` output, the archive of record: `archive-index.json` plus the npm
// tarballs it names. Nothing is re-derived. Each version's metadata is the `metadata.json` inside
// its own tarball, byte for byte, and the tarball's integrity is recomputed and must match the
// index. The input must be what the release published and seeds into images — see the feature doc
// for why this is not wired into a release yet.
//
// Append-only, and all or nothing:
// - a version already in the catalogue is never changed. The same artifact and metadata again is a
//   no-op, so a re-run is safe; anything different is refused, because a version is never
//   republished (ADR-0001);
// - nothing is ever removed;
// - one bad artifact refuses the whole run before anything is written. Metadata files are written
//   first and the index last, by rename, so an interrupted run leaves the published index as it was.
//   A re-run of the same archive picks up where it stopped: a metadata file already in place with
//   the same bytes is reused, also when the interrupted run was the first and wrote no index yet.
export const qadamVersionCatalogueWriter = {
    append: async ({ catalogueDir, archiveDir }: AppendParams): Promise<AppendResult> => {
        const existing = await loadExisting({ catalogueDir })
        if (existing.status === 'invalid') {
            return { status: 'refused', problems: existing.problems }
        }
        const archive = await readArchiveIndex({ archiveDir })
        if (archive.status === 'invalid') {
            return { status: 'refused', problems: [{ reason: archive.reason }] }
        }
        const duplicates = findDuplicates({ artifacts: archive.artifacts })
        if (duplicates.length > 0) {
            return { status: 'refused', problems: duplicates.map((coordinates) => ({ ...coordinates, reason: 'listed twice in the archive index' })) }
        }
        const prepared = await mapWithConcurrency({ items: archive.artifacts, fn: (artifact) => prepareArtifact({ artifact, archiveDir }) })
        const planned = await mapWithConcurrency({ items: prepared, fn: (item) => planItem({ item, existing: existing.qadams, catalogueDir }) })
        const problems = planned.flatMap((plan) => plan.status === 'problem' ? [plan.problem] : [])
        if (problems.length > 0) {
            return { status: 'refused', problems }
        }
        const added = planned.flatMap((plan) => plan.status === 'add' ? [plan.version] : [])
        if (!existing.hasIndex) {
            const unaccounted = await findUnaccountedFiles({ catalogueDir, added })
            if (unaccounted.length > 0) {
                return { status: 'refused', problems: [{ reason: `the catalogue has metadata files but no index, and this archive does not add ${unaccounted.slice(0, 3).join(', ')}${unaccounted.length > 3 ? ', …' : ''}: restore index.json, or remove those files if this is meant to be a new catalogue` }] }
            }
        }
        const unchanged = planned.flatMap((plan) => plan.status === 'unchanged' ? [plan.version] : [])
        if (added.length === 0 && existing.hasIndex) {
            return { status: 'appended', added: [], unchanged: unchanged.map(toCoordinates) }
        }
        for (const version of added) {
            const target = path.join(catalogueDir, qadamVersionCatalogueFormat.metadataPath(version))
            await mkdir(path.dirname(target), { recursive: true })
            if (!version.metadataFileExists) {
                await writeFile(target, version.metadataBytes, { flag: 'wx' })
            }
        }
        const merged: CatalogueEntries = new Map([...existing.qadams].map(([name, versions]) => [name, new Map(versions)]))
        for (const version of added) {
            const versions = merged.get(version.name) ?? new Map<string, QadamVersionCatalogueEntry>()
            versions.set(version.version, version.entry)
            merged.set(version.name, versions)
        }
        await writeIndexAtomically({ catalogueDir, content: qadamVersionCatalogueFormat.serializeIndex({ qadams: merged }) })
        return { status: 'appended', added: added.map(toCoordinates), unchanged: unchanged.map(toCoordinates) }
    },

    // Every entry parses strictly, and every metadata file exists, matches its integrity and size,
    // is qadam metadata for that name and version, and agrees with the release floors in the index.
    // What a mirror or the Pages repository can run as a check.
    verify: async ({ catalogueDir }: { catalogueDir: string }): Promise<VerifyResult> => {
        const index = await readStrictIndex({ catalogueDir })
        if (index.status !== 'ok') {
            return { status: 'invalid', problems: [{ reason: index.status === 'missing' ? 'no index' : index.reason }] }
        }
        const problems = await verifyEntries({ catalogueDir, qadams: index.qadams })
        const versions = [...index.qadams.values()].reduce((count, versionsOfQadam) => count + versionsOfQadam.size, 0)
        return problems.length > 0 ? { status: 'invalid', problems } : { status: 'ok', qadams: index.qadams.size, versions }
    },
}

const ARCHIVE_INDEX_FILE = 'archive-index.json'
const ARCHIVE_INDEX_FORMAT_VERSION = 1
const ARTIFACT_FORMAT_VERSION = 1
const TARBALL_PACKAGE_JSON = 'package/package.json'
const TARBALL_METADATA_JSON = 'package/metadata.json'
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
// Bounds the tarballs held in memory and the `tar` processes running at once.
const CONCURRENCY = 4

// #804's `archive-index.json` (`writeArchiveIndex` in `tools/scripts/qadams/bundle/build-qadam-artifacts.mjs`).
const ArchiveIndex = z.object({
    formatVersion: z.literal(ARCHIVE_INDEX_FORMAT_VERSION),
    artifacts: z.array(z.object({
        name: z.string(),
        version: z.string(),
        kind: z.string(),
        file: z.string(),
        integrity: z.string(),
        size: z.number().int().nonnegative(),
        commit: z.object({
            sha: z.string(),
            dirtyQadams: z.boolean(),
        }),
    })),
})

const ArtifactPackageJson = z.object({
    name: z.string(),
    version: z.string(),
    qadamArtifact: z.object({
        formatVersion: z.number(),
        kind: z.string(),
    }),
})

const ArtifactKind = z.enum([QadamVersionCatalogueArtifactKind.BUNDLE, QadamVersionCatalogueArtifactKind.BUNDLE_WITH_NODE_MODULES])

// `tar` rather than a parser in this package: this runs in the release pipeline on artifacts the same
// pipeline built, never on input from a user. The tarball goes in on stdin, so what is extracted is
// exactly the buffer whose integrity was checked, not the file read again; the member is a constant,
// so it cannot be read as an option. Output past `maxBytes` stops the extraction.
function extractFromTarball({ tarball, member, maxBytes }: ExtractFromTarballParams): Promise<ExtractFromTarballResult> {
    return new Promise((resolve) => {
        const child = spawn('tar', ['-xzOf', '-', member], { stdio: ['pipe', 'pipe', 'ignore'] })
        const chunks: Buffer[] = []
        let length = 0
        let tooLarge = false
        child.stdout.on('data', (chunk: Buffer) => {
            length += chunk.length
            if (length > maxBytes) {
                tooLarge = true
                child.kill()
                return
            }
            chunks.push(chunk)
        })
        // `tar` may exit before it has read all of stdin (a missing member, or killed above).
        child.stdin.on('error', () => undefined)
        child.on('error', () => resolve({ status: 'error', reason: `cannot read ${member} from the tarball` }))
        child.on('close', (code) => {
            if (tooLarge) {
                resolve({ status: 'error', reason: `${member} is too large` })
                return
            }
            resolve(code === 0 ? { status: 'ok', bytes: Buffer.concat(chunks) } : { status: 'error', reason: `cannot read ${member} from the tarball` })
        })
        child.stdin.end(tarball)
    })
}

async function loadExisting({ catalogueDir }: { catalogueDir: string }): Promise<LoadExistingResult> {
    const index = await readStrictIndex({ catalogueDir })
    if (index.status === 'missing') {
        // A new catalogue, or a first run that stopped before its index. Files that no index and no
        // version of this run account for are refused once the run is planned (`findUnaccountedFiles`).
        return { status: 'ok', qadams: new Map(), hasIndex: false }
    }
    if (index.status === 'invalid') {
        return { status: 'invalid', problems: [{ reason: `the existing index cannot be appended to: ${index.reason}` }] }
    }
    const problems = await verifyEntries({ catalogueDir, qadams: index.qadams })
    if (problems.length > 0) {
        return { status: 'invalid', problems }
    }
    return { status: 'ok', qadams: index.qadams, hasIndex: true }
}

async function readStrictIndex({ catalogueDir }: { catalogueDir: string }): Promise<ReadStrictIndexResult> {
    const { data: content, error } = await tryCatch(() => readFile(path.join(catalogueDir, QADAM_VERSION_CATALOGUE_INDEX_FILE), 'utf8'))
    if (error) {
        return isFileNotFound(error) ? { status: 'missing' } : { status: 'invalid', reason: 'unreadable' }
    }
    const { data: json, error: parseError } = tryCatchSync((): unknown => JSON.parse(content))
    if (parseError) {
        return { status: 'invalid', reason: 'not JSON' }
    }
    return qadamVersionCatalogueFormat.parseIndexStrict(json)
}

async function readArchiveIndex({ archiveDir }: { archiveDir: string }): Promise<ReadArchiveIndexResult> {
    const { data: content, error } = await tryCatch(() => readFile(path.join(archiveDir, ARCHIVE_INDEX_FILE), 'utf8'))
    if (error) {
        return { status: 'invalid', reason: `cannot read ${ARCHIVE_INDEX_FILE}` }
    }
    const { data: json, error: parseError } = tryCatchSync((): unknown => JSON.parse(content))
    const parsed = parseError ? null : ArchiveIndex.safeParse(json)
    if (isNil(parsed) || !parsed.success) {
        return { status: 'invalid', reason: `${ARCHIVE_INDEX_FILE} is not a format-${ARCHIVE_INDEX_FORMAT_VERSION} archive index` }
    }
    return { status: 'ok', artifacts: parsed.data.artifacts }
}

async function prepareArtifact({ artifact, archiveDir }: PrepareArtifactParams): Promise<PreparedArtifact> {
    const { name, version } = artifact
    const problem = (reason: string): PreparedArtifact => ({ status: 'problem', problem: { name, version, reason } })
    if (!qadamVersionCatalogueFormat.isCatalogueName(name)) {
        return problem('not an official qadam name (`@aiqadam/qadam-*`)')
    }
    if (!qadamVersionCatalogueFormat.isCatalogueVersion(version)) {
        return problem('not a canonical semver version')
    }
    // Only released versions belong here. `main` builds' snapshot versions are never in the
    // catalogue (ADR-0004, proposed), and no other qadam prerelease channel exists.
    if (!isNil(semVer.prerelease(version))) {
        return problem('a prerelease version, which is never released')
    }
    // Release artifacts are archived when built and never rebuilt (ADR-0003); one built from a tree
    // with uncommitted qadam changes cannot be traced to a commit.
    if (artifact.commit.dirtyQadams || !/^[0-9a-f]{40}$/.test(artifact.commit.sha)) {
        return problem('not built from a clean commit')
    }
    const kind = ArtifactKind.safeParse(artifact.kind)
    if (!kind.success) {
        return problem(`unknown artifact kind ${JSON.stringify(artifact.kind)}`)
    }
    if (path.basename(artifact.file) !== artifact.file || !artifact.file.endsWith('.tgz') || artifact.file.startsWith('.')) {
        return problem('the tarball is not a plain .tgz file name')
    }
    const { data: tarball, error } = await tryCatch(() => readFile(path.resolve(archiveDir, artifact.file)))
    if (error) {
        return problem('the tarball cannot be read')
    }
    if (tarball.length !== artifact.size || qadamVersionCatalogueFormat.integrityOf(tarball) !== artifact.integrity) {
        return problem('the tarball does not match the integrity and size in the archive index')
    }
    const packageJson = await extractFromTarball({ tarball, member: TARBALL_PACKAGE_JSON, maxBytes: MAX_PACKAGE_JSON_BYTES })
    if (packageJson.status === 'error') {
        return problem(packageJson.reason)
    }
    const { data: packageJsonValue, error: packageJsonError } = tryCatchSync((): unknown => JSON.parse(packageJson.bytes.toString('utf8')))
    const manifest = packageJsonError ? null : ArtifactPackageJson.safeParse(packageJsonValue)
    if (isNil(manifest) || !manifest.success || manifest.data.name !== name || manifest.data.version !== version) {
        return problem('the tarball\'s package.json does not name this qadam version')
    }
    if (manifest.data.qadamArtifact.formatVersion !== ARTIFACT_FORMAT_VERSION || manifest.data.qadamArtifact.kind !== kind.data) {
        return problem('the tarball is not a format-1 artifact of the kind the archive index names')
    }
    const metadataFile = await extractFromTarball({ tarball, member: TARBALL_METADATA_JSON, maxBytes: QADAM_VERSION_CATALOGUE_MAX_METADATA_BYTES })
    if (metadataFile.status === 'error') {
        return problem(metadataFile.reason)
    }
    const metadata = qadamVersionCatalogueFormat.checkMetadataFile({ bytes: metadataFile.bytes, name, version })
    if (metadata.status !== 'ok') {
        return problem(`metadata.json is not qadam metadata for this qadam version (${metadata.status})`)
    }
    const entry: QadamVersionCatalogueEntry = {
        artifact: { format: QadamVersionCatalogueArtifactFormat.BUNDLE, kind: kind.data, integrity: artifact.integrity, size: artifact.size },
        metadata: metadata.file,
        minimumSupportedRelease: metadata.metadata.minimumSupportedRelease,
        maximumSupportedRelease: metadata.metadata.maximumSupportedRelease,
        commit: artifact.commit.sha,
    }
    return { status: 'ok', name, version, entry, metadataBytes: metadataFile.bytes }
}

async function planItem({ item, existing, catalogueDir }: PlanItemParams): Promise<Plan> {
    if (item.status === 'problem') {
        return item
    }
    const { name, version, entry } = item
    const current = existing.get(name)?.get(version)
    if (!isNil(current)) {
        return qadamVersionCatalogueFormat.isSameEntry({ left: current, right: entry })
            ? { status: 'unchanged', version: item }
            : { status: 'problem', problem: { name, version, reason: 'already in the catalogue with a different artifact or metadata; a version is never republished' } }
    }
    // A metadata file without an index entry is left by an interrupted run. The same bytes are
    // reused; anything else is refused rather than overwritten.
    const target = path.join(catalogueDir, qadamVersionCatalogueFormat.metadataPath({ name, version }))
    const { data: onDisk, error } = await tryCatch(() => readFile(target))
    if (error && !isFileNotFound(error)) {
        return { status: 'problem', problem: { name, version, reason: 'the metadata file already in place cannot be read' } }
    }
    if (!isNil(onDisk) && !onDisk.equals(item.metadataBytes)) {
        return { status: 'problem', problem: { name, version, reason: 'a different metadata file is already in place' } }
    }
    return { status: 'add', version: { ...item, metadataFileExists: !isNil(onDisk) } }
}

async function verifyEntries({ catalogueDir, qadams }: { catalogueDir: string, qadams: CatalogueEntries }): Promise<Problem[]> {
    const entries = [...qadams].flatMap(([name, versions]) => [...versions].map(([version, entry]) => ({ name, version, entry })))
    const checks = await mapWithConcurrency({ items: entries, fn: ({ name, version, entry }) => verifyEntry({ catalogueDir, name, version, entry }) })
    return checks.filter((problem): problem is Problem => !isNil(problem))
}

async function verifyEntry({ catalogueDir, name, version, entry }: VerifyEntryParams): Promise<Problem | null> {
    const problem = (reason: string): Problem => ({ name, version, reason })
    const { data: bytes, error } = await tryCatch(() => readFile(path.join(catalogueDir, qadamVersionCatalogueFormat.metadataPath({ name, version }))))
    if (error) {
        return problem(isFileNotFound(error) ? 'metadata file missing' : 'metadata file unreadable')
    }
    const metadata = qadamVersionCatalogueFormat.checkMetadataFile({ bytes, name, version, expected: entry.metadata })
    switch (metadata.status) {
        case 'integrity-mismatch':
            return problem('metadata file does not match its integrity')
        case 'not-json':
        case 'not-qadam-metadata':
        case 'other-version':
            return problem('metadata file is not qadam metadata for this qadam version')
        case 'ok':
            break
    }
    if (metadata.metadata.minimumSupportedRelease !== entry.minimumSupportedRelease || metadata.metadata.maximumSupportedRelease !== entry.maximumSupportedRelease) {
        return problem('the index\'s release floors differ from the metadata\'s')
    }
    return null
}

// With no index, every file under the metadata directory must be one this run adds (`planItem` has
// already checked that one in place has the same bytes): that is a first run that stopped before
// its index. Anything else is a catalogue whose index was lost, and a new index written over it
// would drop every version it listed.
async function findUnaccountedFiles({ catalogueDir, added }: { catalogueDir: string, added: Coordinates[] }): Promise<string[]> {
    const { data: dirents, error } = await tryCatch(() => readdir(path.join(catalogueDir, QADAM_VERSION_CATALOGUE_METADATA_DIR), { recursive: true, withFileTypes: true }))
    if (error) {
        return isFileNotFound(error) ? [] : [`${QADAM_VERSION_CATALOGUE_METADATA_DIR}/ (unreadable)`]
    }
    const expected = new Set(added.map((coordinates) => qadamVersionCatalogueFormat.metadataPath(coordinates)))
    return dirents
        .filter((dirent) => !dirent.isDirectory())
        .map((dirent) => path.relative(catalogueDir, path.join(dirent.parentPath, dirent.name)).split(path.sep).join('/'))
        .filter((relative) => !expected.has(relative))
        .sort()
}

function findDuplicates({ artifacts }: { artifacts: ArchiveArtifact[] }): Coordinates[] {
    const keys = artifacts.map(({ name, version }) => `${name}@${version}`)
    return artifacts.filter(({ name, version }, index) => keys.indexOf(`${name}@${version}`) !== index).map(({ name, version }) => ({ name, version }))
}

async function writeIndexAtomically({ catalogueDir, content }: { catalogueDir: string, content: string }): Promise<void> {
    const target = path.join(catalogueDir, QADAM_VERSION_CATALOGUE_INDEX_FILE)
    const temporary = `${target}.${process.pid}.tmp`
    await mkdir(catalogueDir, { recursive: true })
    try {
        await writeFile(temporary, content, { flag: 'wx' })
        await rename(temporary, target)
    }
    finally {
        await rm(temporary, { force: true })
    }
}

async function mapWithConcurrency<T, R>({ items, fn }: { items: T[], fn: (item: T) => Promise<R> }): Promise<R[]> {
    const lanes = Array.from({ length: Math.min(CONCURRENCY, items.length) }, (_, lane) => lane)
    const perLane = await Promise.all(lanes.map(async (lane) => {
        const results: { index: number, result: R }[] = []
        for (let index = lane; index < items.length; index += lanes.length) {
            results.push({ index, result: await fn(items[index]) })
        }
        return results
    }))
    return perLane.flat().sort((a, b) => a.index - b.index).map(({ result }) => result)
}

function toCoordinates({ name, version }: Coordinates): Coordinates {
    return { name, version }
}

function isFileNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

type Coordinates = {
    name: string
    version: string
}

type Problem = Partial<Coordinates> & {
    reason: string
}

type ArchiveArtifact = z.infer<typeof ArchiveIndex>['artifacts'][number]

type ExtractFromTarballParams = {
    tarball: Buffer
    member: string
    maxBytes: number
}

type ExtractFromTarballResult =
    | { status: 'ok', bytes: Buffer }
    | { status: 'error', reason: string }

type PreparedVersion = Coordinates & {
    entry: QadamVersionCatalogueEntry
    metadataBytes: Buffer
}

type PreparedArtifact =
    | ({ status: 'ok' } & PreparedVersion)
    | { status: 'problem', problem: Problem }

type Plan =
    | { status: 'add', version: PreparedVersion & { metadataFileExists: boolean } }
    | { status: 'unchanged', version: PreparedVersion }
    | { status: 'problem', problem: Problem }

type PlanItemParams = {
    item: PreparedArtifact
    existing: CatalogueEntries
    catalogueDir: string
}

type PrepareArtifactParams = {
    artifact: ArchiveArtifact
    archiveDir: string
}

type VerifyEntryParams = Coordinates & {
    catalogueDir: string
    entry: QadamVersionCatalogueEntry
}

type LoadExistingResult =
    | { status: 'ok', qadams: CatalogueEntries, hasIndex: boolean }
    | { status: 'invalid', problems: Problem[] }

type ReadStrictIndexResult =
    | { status: 'ok', qadams: CatalogueEntries }
    | { status: 'missing' }
    | { status: 'invalid', reason: string }

type ReadArchiveIndexResult =
    | { status: 'ok', artifacts: ArchiveArtifact[] }
    | { status: 'invalid', reason: string }

type AppendParams = {
    catalogueDir: string
    archiveDir: string
}

export type AppendResult =
    | { status: 'appended', added: Coordinates[], unchanged: Coordinates[] }
    | { status: 'refused', problems: Problem[] }

export type VerifyResult =
    | { status: 'ok', qadams: number, versions: number }
    | { status: 'invalid', problems: Problem[] }
