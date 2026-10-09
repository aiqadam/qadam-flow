import { createHash } from 'node:crypto'
import { lstat, open, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tryCatch } from '@aiqadam/shared'
import { QADAM_VERSION_STORE_LAYOUT, qadamVersionStoreLayout } from './qadam-version-store-layout'

export const qadamVersionStoreTree = {
    // Lists every entry below `root` without following a symlink, and refuses what a version must
    // never contain: a device, socket or FIFO, a hard link (a file whose content another path can
    // change), or a symlink that is absolute or resolves outside `root`. Symlinks are accepted
    // only so a version installed by a package manager (`node_modules/.bin`) can be stored; the
    // store's own tarball extraction never creates one.
    walk: async ({ root, limits }: WalkParams): Promise<WalkResult> => {
        const realRoot = await realpath(root)
        const pending: string[] = ['']
        const entries: TreeEntry[] = []
        const totals = { files: 0, bytes: 0 }
        while (pending.length > 0) {
            const relativeDir = pending.pop() ?? ''
            const dirents = await readdir(path.join(root, relativeDir), { withFileTypes: true })
            for (const dirent of dirents) {
                const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`
                const absolutePath = path.join(root, relativePath)
                if (entries.length >= limits.maxEntries) {
                    return { ok: false, reason: `more than ${limits.maxEntries} entries` }
                }
                if (dirent.isDirectory()) {
                    entries.push({ kind: 'directory', path: relativePath })
                    pending.push(relativePath)
                    continue
                }
                if (dirent.isSymbolicLink()) {
                    const link = await checkSymlink({ realRoot, absolutePath, relativePath })
                    if (!link.ok) {
                        return link
                    }
                    entries.push(link.entry)
                    continue
                }
                if (!dirent.isFile()) {
                    return { ok: false, reason: `${relativePath} is not a regular file, directory or symlink` }
                }
                const stats = await lstat(absolutePath)
                if (stats.nlink > 1) {
                    return { ok: false, reason: `${relativePath} is a hard link` }
                }
                totals.files += 1
                totals.bytes += stats.size
                if (totals.bytes > limits.maxBytes) {
                    return { ok: false, reason: `more than ${limits.maxBytes} bytes` }
                }
                entries.push({ kind: 'file', path: relativePath, size: stats.size, executable: (stats.mode & 0o111) !== 0 })
            }
        }
        return { ok: true, tree: { entries: entries.sort(compareByPath), files: totals.files, bytes: totals.bytes } }
    },

    // One sha512 over the sorted list of every entry except `integrity.json` itself: path, kind,
    // the executable bit, and the content's own sha512 (or a symlink's target). Any added, removed,
    // renamed, re-targeted or rewritten file changes it. With `sync`, each file is also flushed to
    // disk as it is read, so a version renamed into place after this has its content on disk.
    digest: async ({ root, tree, sync }: DigestParams): Promise<string> => {
        const hash = createHash('sha512')
        for (const entry of tree.entries) {
            if (entry.path === QADAM_VERSION_STORE_LAYOUT.integrityFile) {
                continue
            }
            if (entry.kind === 'directory') {
                hash.update(`d\0${entry.path}\n`)
                continue
            }
            if (entry.kind === 'symlink') {
                hash.update(`l\0${entry.path}\0${entry.target}\n`)
                continue
            }
            const contentDigest = await hashFile({ filePath: path.join(root, entry.path), sync })
            hash.update(`f\0${entry.path}\0${entry.executable ? 'x' : '-'}\0${contentDigest}\n`)
        }
        return `sha512-${hash.digest('base64')}`
    },

    has: ({ tree, relativePath, kind }: HasParams): boolean => {
        return tree.entries.some((entry) => entry.path === relativePath && entry.kind === kind)
    },
}

async function checkSymlink({ realRoot, absolutePath, relativePath }: CheckSymlinkParams): Promise<SymlinkCheck> {
    const target = await readlink(absolutePath)
    if (path.isAbsolute(target)) {
        return { ok: false, reason: `${relativePath} is a symlink with an absolute target` }
    }
    // The target as written must stay inside: a link that only resolves inside today because of
    // what else is on disk is refused too.
    const lexical = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), target))
    if (lexical === '.' || lexical === '..' || lexical.startsWith('../')) {
        return { ok: false, reason: `${relativePath} is a symlink that points outside the version` }
    }
    // realpath follows every link in the chain, so a chain whose links each look harmless but
    // together climb out (`a -> .`, `b -> a/..`) is caught; a dangling link is refused too.
    const resolved = await tryCatch(() => realpath(absolutePath))
    if (resolved.error !== null) {
        return { ok: false, reason: `${relativePath} is a symlink that does not resolve` }
    }
    const inside = path.relative(realRoot, resolved.data)
    if (inside === '' || qadamVersionStoreLayout.isOutside({ relative: inside })) {
        return { ok: false, reason: `${relativePath} is a symlink that resolves outside the version` }
    }
    return { ok: true, entry: { kind: 'symlink', path: relativePath, target } }
}

async function hashFile({ filePath, sync }: { filePath: string, sync: boolean }): Promise<string> {
    const handle = await open(filePath, 'r')
    try {
        const hash = createHash('sha512')
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
            hash.update(chunk)
        }
        if (sync) {
            await handle.datasync()
        }
        return hash.digest('base64')
    }
    finally {
        await handle.close()
    }
}

function compareByPath(a: TreeEntry, b: TreeEntry): number {
    if (a.path === b.path) {
        return 0
    }
    return a.path < b.path ? -1 : 1
}

export type TreeEntry =
    | { kind: 'directory', path: string }
    | { kind: 'file', path: string, size: number, executable: boolean }
    | { kind: 'symlink', path: string, target: string }

export type QadamVersionTree = {
    entries: TreeEntry[]
    files: number
    bytes: number
}

export type QadamVersionStoreLimits = {
    maxEntries: number
    maxBytes: number
}

type WalkParams = {
    root: string
    limits: QadamVersionStoreLimits
}

type WalkResult = { ok: true, tree: QadamVersionTree } | { ok: false, reason: string }

type SymlinkCheck = { ok: true, entry: TreeEntry } | { ok: false, reason: string }

type CheckSymlinkParams = {
    realRoot: string
    absolutePath: string
    relativePath: string
}

type DigestParams = {
    root: string
    tree: QadamVersionTree
    sync: boolean
}

type HasParams = {
    tree: QadamVersionTree
    relativePath: string
    kind: TreeEntry['kind']
}
