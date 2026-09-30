import fs from 'fs/promises'
import path from 'path'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { z } from 'zod'

// Bundled qadams are baked into the image, so the index cannot change while the process lives.
// The cache holds the in-flight promise so concurrent steps share one build.
let distIndexCache: Promise<Map<string, DistPackageEntry>> | null = null

export const qadamDistIndex = {
    get: async ({ refresh, warn }: GetParams): Promise<Map<string, DistPackageEntry>> => {
        if (!refresh && !isNil(distIndexCache)) {
            return distIndexCache
        }
        // A refresh is a dev-qadam lookup: its dist is rebuilt while the process lives, so only a
        // scan can see it. The image-build manifest is for the bundled tree, which cannot change.
        const building = qadamDistIndex.load({ qadamsRoot: defaultQadamsRoot(), useManifest: !refresh, warn })
        distIndexCache = building
        void building.catch(() => {
            if (distIndexCache === building) {
                distIndexCache = null
            }
        })
        return building
    },

    load: async ({ qadamsRoot, useManifest, warn }: LoadParams): Promise<Map<string, DistPackageEntry>> => {
        const root = path.resolve(qadamsRoot)
        if (useManifest) {
            const fromManifest = await readManifest({ qadamsRoot: root, warn })
            if (!isNil(fromManifest)) {
                return fromManifest
            }
        }
        return scanDistTree(root)
    },

    // #419: run at image-build time (Dockerfile), so a fresh engine process reads one file instead
    // of walking ~240 qadam directories — 270–540 ms of the first `resolveMs` on QA.
    writeManifest: async ({ qadamsRoot }: WriteManifestParams): Promise<number> => {
        const root = path.resolve(qadamsRoot)
        const index = await scanDistTree(root)
        const manifest: DistIndexManifest = {
            version: MANIFEST_VERSION,
            entries: [...index.values()].map((entry) => ({
                name: entry.name,
                version: entry.version,
                indexPath: path.relative(root, entry.indexPath),
            })),
        }
        await fs.writeFile(path.join(root, MANIFEST_FILE), JSON.stringify(manifest))
        return manifest.entries.length
    },
}

// The .gitignore entry names this file too.
const MANIFEST_FILE = 'dist-index.json'
const MANIFEST_VERSION = 1
const IGNORED_DIRS = ['node_modules', '.turbo', 'framework', 'common']

// `version` tolerated as missing or null so a package.json the old name-only index accepted stays
// resolvable; it just never wins the same-version check.
const distPackageJsonSchema = z.object({ name: z.string(), version: z.string().nullish() })
const manifestSchema = z.object({
    version: z.literal(MANIFEST_VERSION),
    entries: z.array(z.object({ name: z.string(), version: z.string().nullable(), indexPath: z.string() })),
})

function defaultQadamsRoot(): string {
    return path.resolve('packages/qadams')
}

// Any problem with the manifest means "scan instead": it must never make a bundled qadam
// unresolvable. A missing file is the normal dev-tree case and stays quiet; anything else is an
// image built wrong, and says why. This is no staleness check: a qadam built after the manifest was
// written is simply not in it, which is why only the image build writes one (the file is
// gitignored) and a dev-qadam refresh never reads it.
async function readManifest({ qadamsRoot, warn }: ReadManifestParams): Promise<Map<string, DistPackageEntry> | null> {
    const rejectedBecause = (reason: string): null => rejectManifest({ warn, reason })
    const { data: content, error: readError } = await tryCatch(() => fs.readFile(path.join(qadamsRoot, MANIFEST_FILE), 'utf-8'))
    if (readError) {
        return isFileNotFound(readError) ? null : rejectedBecause('unreadable')
    }
    const { data: parsed } = tryCatchSync(() => manifestSchema.safeParse(JSON.parse(content)))
    if (isNil(parsed) || !parsed.success) {
        return rejectedBecause('not a version-1 manifest')
    }
    // Trusted as the whole bundled tree, so an empty one would make every bundled qadam unresolvable.
    if (parsed.data.entries.length === 0) {
        return rejectedBecause('no entries')
    }
    const entries = parsed.data.entries.map((entry) => ({ ...entry, indexPath: path.resolve(qadamsRoot, entry.indexPath) }))
    if (entries.some((entry) => !entry.indexPath.startsWith(qadamsRoot + path.sep))) {
        return rejectedBecause('an entry points outside the qadams root')
    }
    const present = await Promise.all(entries.map((entry) => pathExists(entry.indexPath)))
    if (present.includes(false)) {
        return rejectedBecause('an entry has no built dist')
    }
    return toIndex(entries)
}

// The reason only: never a path, which for a custom qadam install can carry a tenant segment.
function rejectManifest({ warn, reason }: RejectManifestParams): null {
    warn(`[qadamDistIndex] manifest rejected, scanning instead ${JSON.stringify({ reason })}`)
    return null
}

function isFileNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function scanDistTree(qadamsRoot: string): Promise<Map<string, DistPackageEntry>> {
    if (!await pathExists(qadamsRoot)) {
        return new Map()
    }
    const distPackageJsonPaths = await findDistPackageJsonFiles(qadamsRoot)
    const entries = await Promise.all(distPackageJsonPaths.map(readDistPackageEntry))
    return toIndex(entries.filter((entry): entry is DistPackageEntry => !isNil(entry)))
}

function toIndex(entries: DistPackageEntry[]): Map<string, DistPackageEntry> {
    const distIndex = new Map<string, DistPackageEntry>()
    for (const entry of entries) {
        // First match wins, matching the order the sequential scan used to return in.
        if (!distIndex.has(entry.name)) {
            distIndex.set(entry.name, entry)
        }
    }
    return distIndex
}

async function readDistPackageEntry(packageJsonPath: string): Promise<DistPackageEntry | null> {
    const { data } = await tryCatch(async () => {
        const content = await fs.readFile(packageJsonPath, 'utf-8')
        const parsed = distPackageJsonSchema.safeParse(JSON.parse(content))
        if (!parsed.success) {
            return null
        }
        return {
            name: parsed.data.name,
            version: parsed.data.version ?? null,
            indexPath: path.join(path.dirname(packageJsonPath), 'src', 'index.js'),
        }
    })
    return data ?? null
}

async function findDistPackageJsonFiles(dirPath: string): Promise<string[]> {
    const results: string[] = []

    async function scanDir(currentPath: string): Promise<void> {
        const items = await fs.readdir(currentPath, { withFileTypes: true })
        for (const item of items) {
            if (!item.isDirectory() || IGNORED_DIRS.includes(item.name)) {
                continue
            }
            const fullPath = path.join(currentPath, item.name)
            if (item.name === 'dist') {
                const pkgJson = path.join(fullPath, 'package.json')
                if (await pathExists(pkgJson)) {
                    results.push(pkgJson)
                }
            }
            else {
                await scanDir(fullPath)
            }
        }
    }

    await scanDir(dirPath)
    return results
}

async function pathExists(filePath: string): Promise<boolean> {
    const { error } = await tryCatch(() => fs.access(filePath))
    return isNil(error)
}

export type DistPackageEntry = {
    name: string
    // `null` when the bundled package.json carries no usable version — such a build can never
    // claim an alias's version, so it never wins the #503 same-version check.
    version: string | null
    indexPath: string
}

type DistIndexManifest = z.infer<typeof manifestSchema>

// Where a rejected manifest says why. The warmup passes the unpatched console, so its line stays out
// of any job's log; a job that is the first to build the index passes its own console, and the line
// lands in that job's log, beside the scan it paid for.
export type WarnSink = (line: string) => void

type GetParams = {
    refresh: boolean
    warn: WarnSink
}

type LoadParams = {
    qadamsRoot: string
    useManifest: boolean
    warn: WarnSink
}

type ReadManifestParams = {
    qadamsRoot: string
    warn: WarnSink
}

type WriteManifestParams = {
    qadamsRoot: string
}

type RejectManifestParams = {
    warn: WarnSink
    reason: string
}
