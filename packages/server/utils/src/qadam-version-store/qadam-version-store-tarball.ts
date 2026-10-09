import { createHash } from 'node:crypto'
import { FileHandle, mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { isNil } from '@aiqadam/shared'
import { Parser, ReadEntry } from 'tar'
import { QadamVersionStoreLimits } from './qadam-version-store-tree'

export const qadamVersionStoreTarball = {
    isSupportedIntegrity: ({ integrity }: { integrity: string }): boolean => SHA512_INTEGRITY.test(integrity),

    // Extracts an npm-style tarball (every entry under one top-level directory, `package/` for
    // anything `npm pack` wrote) into `destination`, which must be a fresh, empty directory the
    // caller owns. Written for an archive from anywhere, so it trusts nothing in it:
    // - only regular files and directories; a symlink, hard link, device or FIFO refuses the archive,
    //   which also rules out every link-then-write-through-it traversal;
    // - a path is relative, has no `.`/`..`/empty segment, no backslash or NUL, and the same path
    //   never appears twice; each file is created with `wx`, so nothing is overwritten;
    // - modes are reduced to 0644 / 0755 — no setuid, no owner from the archive;
    // - limits on entry count, declared bytes, one file's bytes, and the decompression ratio
    //   (node-tar's own guard), checked before a byte of an entry is written.
    // Any refusal aborts the parse; the caller removes `destination`.
    //
    // The tarball is read once, through one descriptor, and its sha512 (npm's `dist.integrity` form)
    // is computed from the very bytes that were parsed and returned with the result. The caller
    // compares it before using what was extracted: hashing the file first and extracting it in a
    // second read would let the file change in between.
    extract: async ({ file, destination, limits }: ExtractParams): Promise<ExtractResult> => {
        const handle = await open(file, 'r')
        try {
            const size = (await handle.stat()).size
            if (size > limits.maxBytes) {
                return { ok: false, reason: `the tarball is larger than ${limits.maxBytes} bytes` }
            }
            return await extractFrom({ handle, destination, limits })
        }
        finally {
            await handle.close()
        }
    },
}

async function extractFrom({ handle, destination, limits }: ExtractFromParams): Promise<ExtractResult> {
    const seen = new Set<string>()
    const counters: ExtractCounters = { entries: 0, bytes: 0, topLevel: null }
    const outcome: { failure: string | null } = { failure: null }
    const queue = sequentialQueue()
    const parser = new Parser({ strict: true })
    const fail = (reason: string): void => {
        if (isNil(outcome.failure)) {
            outcome.failure = reason
        }
        parser.abort(new Error(reason))
    }
    parser.on('entry', (entry: ReadEntry) => {
        const { decision, next } = admitEntry({ entry, counters, limits })
        Object.assign(counters, next)
        if (decision.kind !== 'refuse' && decision.segments.length > 0) {
            const key = decision.segments.join('/')
            if (seen.has(key)) {
                entry.resume()
                fail('the same path appears twice')
                return
            }
            seen.add(key)
        }
        if (decision.kind === 'refuse') {
            entry.resume()
            fail(decision.reason)
            return
        }
        const target = path.join(destination, ...decision.segments)
        if (decision.kind === 'directory') {
            queue.push(async () => {
                await mkdir(target, { recursive: true, mode: 0o755 })
            })
            entry.resume()
            return
        }
        writeFileEntry({ entry, target, executable: decision.executable, queue })
    })
    // node-tar skips an entry of a type it does not know, or an oversized extended header, without
    // an `entry` event — so past every limit above. Such an archive is refused.
    parser.on('ignoredEntry', (entry: ReadEntry) => {
        entry.resume()
        fail(`entry type ${entry.type} is not allowed`)
    })
    const finished = new Promise<void>((resolve) => {
        parser.on('end', () => resolve())
        parser.on('error', (error: Error) => {
            if (isNil(outcome.failure)) {
                outcome.failure = `not a readable tarball: ${error.message}`
            }
            resolve()
        })
    })
    const hash = createHash('sha512')
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, highWaterMark: INPUT_CHUNK_BYTES })) {
        if (!isNil(outcome.failure)) {
            break
        }
        hash.update(chunk)
        parser.write(chunk)
        // Every file write the chunk started has completed before the next chunk is parsed, so
        // at most one file is open and memory holds at most one chunk's decompressed bytes.
        await queue.drained().catch((error: unknown) => fail(describeWriteError({ error })))
    }
    if (isNil(outcome.failure)) {
        parser.end()
    }
    await finished
    await queue.drained().catch((error: unknown) => {
        outcome.failure = outcome.failure ?? describeWriteError({ error })
    })
    if (!isNil(outcome.failure)) {
        await queue.abort()
        return { ok: false, reason: outcome.failure }
    }
    if (isNil(counters.topLevel)) {
        return { ok: false, reason: 'the archive is empty' }
    }
    return { ok: true, integrity: `sha512-${hash.digest('base64')}` }
}

const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const INPUT_CHUNK_BYTES = 64 * 1024
const FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])

function admitEntry({ entry, counters, limits }: AdmitEntryParams): { decision: EntryDecision, next: ExtractCounters } {
    const entries = counters.entries + 1
    const refuse = (reason: string): { decision: EntryDecision, next: ExtractCounters } => ({ decision: { kind: 'refuse', reason }, next: { ...counters, entries } })
    if (entries > limits.maxEntries) {
        return refuse(`more than ${limits.maxEntries} entries`)
    }
    const isFile = FILE_TYPES.has(entry.type)
    if (!isFile && entry.type !== 'Directory') {
        return refuse(`entry type ${entry.type} is not allowed`)
    }
    const segments = splitEntryPath({ rawPath: entry.path })
    if (isNil(segments)) {
        return refuse('an entry path is not a plain relative path')
    }
    const [topLevel, ...rest] = segments
    if (!isNil(counters.topLevel) && topLevel !== counters.topLevel) {
        return refuse('entries are not under one top-level directory')
    }
    const withTopLevel: ExtractCounters = { ...counters, entries, topLevel }
    if (!isFile) {
        return { decision: { kind: 'directory', segments: rest }, next: withTopLevel }
    }
    if (rest.length === 0) {
        return refuse('a file sits at the top level of the archive')
    }
    if (entry.size > limits.maxFileBytes) {
        return refuse(`a file is larger than ${limits.maxFileBytes} bytes`)
    }
    const bytes = counters.bytes + entry.size
    if (bytes > limits.maxBytes) {
        return refuse(`more than ${limits.maxBytes} bytes`)
    }
    return { decision: { kind: 'file', segments: rest, executable: ((entry.mode ?? 0) & 0o111) !== 0 }, next: { ...withTopLevel, bytes } }
}

function splitEntryPath({ rawPath }: { rawPath: string }): string[] | null {
    if (rawPath.length === 0 || rawPath.includes('\0') || rawPath.includes('\\') || rawPath.startsWith('/')) {
        return null
    }
    // A directory entry ends in `/`; nothing else may produce an empty segment.
    const segments = rawPath.replace(/\/$/, '').split('/')
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        return null
    }
    return segments
}

function writeFileEntry({ entry, target, executable, queue }: WriteFileEntryParams): void {
    const handle: { current: FileHandle | null } = { current: null }
    queue.push(async () => {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 })
        handle.current = await open(target, 'wx', executable ? 0o755 : 0o644)
    })
    entry.on('data', (chunk: Buffer) => {
        queue.push(async () => {
            const opened = handle.current
            if (isNil(opened)) {
                return
            }
            let offset = 0
            while (offset < chunk.length) {
                const { bytesWritten } = await opened.write(chunk, offset, chunk.length - offset)
                offset += bytesWritten
            }
        })
    })
    entry.on('end', () => {
        queue.push(async () => {
            const opened = handle.current
            handle.current = null
            // Flushed to disk later, once, when the store hashes the staged version for its record.
            await opened?.close()
        })
    })
    // A refusal elsewhere skips the queued writes; the descriptor is still closed.
    queue.onAbort(async () => {
        await handle.current?.close()
        handle.current = null
    })
}

// One promise chain: file operations run strictly in the order the parser produced them. After the
// first failure, the remaining operations are skipped and only the abort hooks run.
function sequentialQueue(): SequentialQueue {
    const chain: { tail: Promise<void>, error: unknown, failed: boolean } = { tail: Promise.resolve(), error: null, failed: false }
    const abortHooks: (() => Promise<void>)[] = []
    return {
        push: (op: () => Promise<void>): void => {
            chain.tail = chain.tail.then(async () => {
                if (chain.failed) {
                    return
                }
                try {
                    await op()
                }
                catch (error) {
                    chain.failed = true
                    chain.error = error
                    await Promise.allSettled(abortHooks.map((hook) => hook()))
                }
            })
        },
        onAbort: (hook: () => Promise<void>): void => {
            abortHooks.push(hook)
        },
        drained: async (): Promise<void> => {
            await chain.tail
            if (chain.failed) {
                throw chain.error
            }
        },
        // For a failure outside the queue (the parser stopped mid-file): skip what is left and close
        // whatever is still open.
        abort: async (): Promise<void> => {
            await chain.tail
            if (!chain.failed) {
                chain.failed = true
                await Promise.allSettled(abortHooks.map((hook) => hook()))
            }
        },
    }
}

function describeWriteError({ error }: { error: unknown }): string {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
    return `could not write an entry (${code})`
}

type SequentialQueue = {
    push: (op: () => Promise<void>) => void
    onAbort: (hook: () => Promise<void>) => void
    drained: () => Promise<void>
    abort: () => Promise<void>
}

type ExtractCounters = {
    entries: number
    bytes: number
    topLevel: string | null
}

export type QadamVersionTarballLimits = QadamVersionStoreLimits & {
    maxFileBytes: number
}

type ExtractParams = {
    file: string
    destination: string
    limits: QadamVersionTarballLimits
}

// `integrity`: sha512 of the bytes that were extracted, `sha512-<base64>`.
type ExtractResult = { ok: true, integrity: string } | { ok: false, reason: string }

type ExtractFromParams = {
    handle: FileHandle
    destination: string
    limits: QadamVersionTarballLimits
}

type AdmitEntryParams = {
    entry: ReadEntry
    counters: ExtractCounters
    limits: QadamVersionTarballLimits
}

type EntryDecision =
    | { kind: 'refuse', reason: string }
    | { kind: 'directory', segments: string[] }
    | { kind: 'file', segments: string[], executable: boolean }

type WriteFileEntryParams = {
    entry: ReadEntry
    target: string
    executable: boolean
    queue: SequentialQueue
}
