import fs from 'fs/promises'
import path from 'path'
import { isNil, tryCatch } from '@aiqadam/shared'
import { z } from 'zod'

// Bundled qadams are baked into the image, so the index cannot change while the process lives.
// The cache holds the in-flight promise so concurrent steps share one build.
let distIndexCache: Promise<Map<string, DistPackageEntry>> | null = null

export const QADAM_DIST_MANIFEST_FILE = 'dist-index.json'

export const qadamDistIndex = {
    get: async ({ refresh }: GetParams): Promise<Map<string, DistPackageEntry>> => {
        if (!refresh && !isNil(distIndexCache)) {
            return distIndexCache
        }
        // A refresh is a dev-qadam lookup: its dist is rebuilt while the process lives, so only a
        // scan can see it. The image-build manifest is for the bundled tree, which cannot change.
        const building = qadamDistIndex.load({ qadamsRoot: defaultQadamsRoot(), useManifest: !refresh })
        distIndexCache = building
        void building.catch(() => {
            if (distIndexCache === building) {
                distIndexCache = null
            }
        })
        return building
    },

    load: async ({ qadamsRoot, useManifest }: LoadParams): Promise<Map<string, DistPackageEntry>> => {
        if (useManifest) {
            const fromManifest = await readManifest(qadamsRoot)
            if (!isNil(fromManifest)) {
                return fromManifest
            }
        }
        return scanDistTree(qadamsRoot)
    },

    // #419: run at image-build time (Dockerfile), so a fresh engine process reads one file instead
    // of walking ~240 qadam directories — 250–540 ms of the first `resolveMs` on QA.
    writeManifest: async ({ qadamsRoot }: WriteManifestParams): Promise<number> => {
        const index = await scanDistTree(qadamsRoot)
        const manifest: DistIndexManifest = {
            version: MANIFEST_VERSION,
            entries: [...index.values()].map((entry) => ({
                name: entry.name,
                version: entry.version,
                indexPath: path.relative(qadamsRoot, entry.indexPath),
            })),
        }
        await fs.writeFile(path.join(qadamsRoot, QADAM_DIST_MANIFEST_FILE), JSON.stringify(manifest))
        return manifest.entries.length
    },
}

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

// Any problem with the manifest means "scan instead": a missing file is the dev tree, and an
// unreadable or foreign one must never make a bundled qadam unresolvable.
async function readManifest(qadamsRoot: string): Promise<Map<string, DistPackageEntry> | null> {
    const { data, error } = await tryCatch(async () => {
        const content = await fs.readFile(path.join(qadamsRoot, QADAM_DIST_MANIFEST_FILE), 'utf-8')
        return manifestSchema.parse(JSON.parse(content))
    })
    if (error) {
        return null
    }
    const entries = data.entries.map((entry) => ({ ...entry, indexPath: path.resolve(qadamsRoot, entry.indexPath) }))
    if (entries.some((entry) => !entry.indexPath.startsWith(qadamsRoot + path.sep))) {
        return null
    }
    return toIndex(entries)
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

type GetParams = {
    refresh: boolean
}

type LoadParams = {
    qadamsRoot: string
    useManifest: boolean
}

type WriteManifestParams = {
    qadamsRoot: string
}
