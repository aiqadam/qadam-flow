import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { QadamMetadata } from '@aiqadam/qadams-framework'
import { isNil, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'

// #598: the image build writes the serialized metadata of every bundled qadam here, so the app's
// first catalogue read is one `readFile` + `JSON.parse` instead of a synchronous `require` of all
// 238 qadams on the event loop (30–63 s on QA, with every request, socket and queue consumer in
// the process waiting behind it). The .gitignore and the Dockerfile name this file too.
export const BUNDLED_QADAMS_MANIFEST_FILE = 'bundled-qadams-metadata.json'

export const bundledQadamsManifest = {
    // `null` means "scan instead". A missing file is the dev-tree case and stays quiet; anything
    // else is an image built wrong, and the warning says why. The result is what the scan would
    // return for the same tree: the writer serialized the scan's own output, and the checks below
    // reject a manifest that no longer describes the dists on disk.
    read: async ({ qadamsRoot, loadTranslations, log }: ReadParams): Promise<QadamMetadata[] | null> => {
        const root = path.resolve(qadamsRoot)
        const rejectedBecause = (reason: string): null => rejectManifest({ log, reason })
        const { data: content, error: readError } = await tryCatch(() => readFile(path.join(root, BUNDLED_QADAMS_MANIFEST_FILE), 'utf-8'))
        if (readError) {
            return isFileNotFound(readError) ? null : rejectedBecause('unreadable')
        }
        const { data: parsed } = tryCatchSync(() => manifestSchema.safeParse(JSON.parse(content)))
        if (isNil(parsed) || !parsed.success) {
            return rejectedBecause(`not a version-${MANIFEST_VERSION} manifest`)
        }
        // Trusted as the whole bundled catalogue, so an empty one would hide every bundled qadam.
        if (parsed.data.qadams.length === 0) {
            return rejectedBecause('no entries')
        }
        const qadams = parsed.data.qadams.map((qadam) => ({
            ...qadam,
            directoryPath: path.resolve(root, qadam.directoryPath),
            // The writer always keeps `i18n`, so the flag can change without a rebuild; the scan
            // reads it only when the flag is on, and this has to return what the scan would.
            i18n: loadTranslations ? qadam.i18n : undefined,
        }))
        if (qadams.some((qadam) => !qadam.directoryPath.startsWith(root + path.sep))) {
            return rejectedBecause('an entry points outside the qadams root')
        }
        const distChecks = await Promise.all(qadams.map((qadam) => checkBuiltDist({ qadam })))
        if (distChecks.includes('missing')) {
            return rejectedBecause('an entry has no built dist')
        }
        // The staleness check. The scan takes a qadam's name and version from its
        // `dist/package.json`, and every qadam change carries a version bump, so a dist rebuilt
        // after the manifest was written shows up here rather than being served from stale data.
        if (distChecks.includes('mismatch')) {
            return rejectedBecause('an entry does not match its built dist')
        }
        return qadams
    },

    // Run once by the Dockerfile (`scripts/write-bundled-qadams-manifest.ts`), handed the scan's own
    // output, so the manifest and the scan cannot disagree about what a qadam's metadata is.
    write: async ({ qadamsRoot, qadams }: WriteParams): Promise<number> => {
        const root = path.resolve(qadamsRoot)
        const manifest: BundledQadamsManifest = {
            version: MANIFEST_VERSION,
            qadams: qadams.map((qadam) => ({
                ...qadam,
                // Relative, so the manifest does not depend on where the tree sits when it is read.
                directoryPath: path.relative(root, directoryPathOrThrow({ qadam })),
            })),
        }
        await writeFile(path.join(root, BUNDLED_QADAMS_MANIFEST_FILE), JSON.stringify(manifest))
        return manifest.qadams.length
    },
}

const MANIFEST_VERSION = 1

const distPackageJsonSchema = z.object({ name: z.string(), version: z.string() })

// Only the fields this file and its callers rely on are checked; the rest is the scan's own
// serialized output, the same shape a CUSTOM qadam's row already stores in `qadam_metadata`.
// `z.custom` rather than `z.object`, because an object schema strips every key it does not list.
const manifestEntrySchema = z.custom<QadamMetadata & { directoryPath: string }>(hasManifestEntryShape)
const manifestSchema = z.object({
    version: z.literal(MANIFEST_VERSION),
    qadams: z.array(manifestEntrySchema),
})

// The reason only, never a path: which entry failed is for whoever rebuilds the image, not the log.
function rejectManifest({ log, reason }: RejectManifestParams): null {
    log.warn({ reason }, '[bundledQadamsManifest] manifest rejected, scanning instead')
    return null
}

// The scan always sets it; a qadam without one cannot be checked against its dist on read.
function directoryPathOrThrow({ qadam }: { qadam: QadamMetadata }): string {
    if (isNil(qadam.directoryPath)) {
        throw new Error(`[bundledQadamsManifest] ${qadam.name} has no directoryPath`)
    }
    return qadam.directoryPath
}

function hasManifestEntryShape(value: unknown): boolean {
    if (typeof value !== 'object' || isNil(value)) {
        return false
    }
    const fields: Record<string, unknown> = { ...value }
    return typeof fields.name === 'string'
        && typeof fields.version === 'string'
        && typeof fields.displayName === 'string'
        && typeof fields.directoryPath === 'string'
        && isPlainObject(fields.actions)
        && isPlainObject(fields.triggers)
}

function isPlainObject(value: unknown): boolean {
    return typeof value === 'object' && !isNil(value) && !Array.isArray(value)
}

async function checkBuiltDist({ qadam }: CheckBuiltDistParams): Promise<DistCheck> {
    const { data: content, error } = await tryCatch(() => readFile(path.join(qadam.directoryPath, 'package.json'), 'utf-8'))
    if (error) {
        return 'missing'
    }
    const { data: parsed } = tryCatchSync(() => distPackageJsonSchema.safeParse(JSON.parse(content)))
    if (isNil(parsed) || !parsed.success) {
        return 'mismatch'
    }
    return parsed.data.name === qadam.name && parsed.data.version === qadam.version ? 'ok' : 'mismatch'
}

function isFileNotFound(error: unknown): boolean {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

type BundledQadamsManifest = z.infer<typeof manifestSchema>

type DistCheck = 'ok' | 'missing' | 'mismatch'

type ReadParams = {
    qadamsRoot: string
    loadTranslations: boolean
    log: FastifyBaseLogger
}

type WriteParams = {
    qadamsRoot: string
    qadams: QadamMetadata[]
}

type RejectManifestParams = {
    log: FastifyBaseLogger
    reason: string
}

type CheckBuiltDistParams = {
    qadam: { name: string, version: string, directoryPath: string }
}
