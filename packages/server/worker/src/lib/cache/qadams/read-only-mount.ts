import { access, constants, open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { QADAM_VERSION_STORE_LAYOUT } from '@aiqadam/server-utils'
import { isNil, tryCatch } from '@aiqadam/shared'

// Whether a directory and everything mounted inside it are read-only to this process (#779: a
// worker must not be able to write the qadam version store its engines load code from).
//
// The mount table answers it. The directory is opened and the kernel names the mount it actually
// reached (`mnt_id` in `/proc/self/fdinfo/<fd>`), so a mount stacked over the store or over one of
// its ancestors after the store's own mount is the one judged, not a mount point that merely looks
// like the longest match. That mount must carry `ro` in `/proc/self/mountinfo`, and so must every
// mount below it (by parent id) whose mount point is inside the directory. It is the only answer
// that holds for any user. `access(W_OK)` is not: Linux (`do_faccessat` in fs/open.c) checks the
// permission bits before it reports a read-only mount, so a worker that is not root gets EACCES on
// a root-owned 0755 store whether or not the mount is read-only, and EACCES also covers a writable
// mount whose subdirectories it can write. Without a mount table (not Linux), only EROFS from
// `access(W_OK)` counts, on the root and on the store's namespace directories. Every unclear
// answer is "not read-only".
export const readOnlyMount = {
    check: async ({ dir }: { dir: string }): Promise<ReadOnlyCheck> => {
        const { data: mountinfo, error } = await tryCatch(() => readFile(MOUNTINFO, 'utf8'))
        if (error !== null) {
            const fallback = await fromAccess({ dirs: namespaceDirs({ dir }) })
            return fallback.readOnly ? fallback : { readOnly: false, reason: `${fallback.reason} (the mount table cannot be read: ${errorCode({ error }) ?? 'unknown error'})` }
        }
        const mountId = await mountIdOf({ dir })
        if (!mountId.ok) {
            return { readOnly: false, reason: `${NOT_READ_ONLY} (the store's mount cannot be identified: ${mountId.reason})` }
        }
        return fromMountInfo({ mountinfo, dir, mountId: mountId.id })
    },
}

const MOUNTINFO = '/proc/self/mountinfo'
const NOT_READ_ONLY = 'the qadam version store is not on a read-only mount'

async function mountIdOf({ dir }: { dir: string }): Promise<MountIdResult> {
    const opened = await tryCatch(() => open(dir, 'r'))
    if (opened.error !== null) {
        return { ok: false, reason: errorCode({ error: opened.error }) ?? 'unknown error' }
    }
    try {
        const fdinfo = await tryCatch(() => readFile(`/proc/self/fdinfo/${opened.data.fd}`, 'utf8'))
        if (fdinfo.error !== null) {
            return { ok: false, reason: errorCode({ error: fdinfo.error }) ?? 'unknown error' }
        }
        const id = /^mnt_id:\s*(\d+)\s*$/m.exec(fdinfo.data)?.[1]
        return isNil(id) ? { ok: false, reason: 'no mnt_id in fdinfo' } : { ok: true, id }
    }
    finally {
        await opened.data.close()
    }
}

function fromMountInfo({ mountinfo, dir, mountId }: { mountinfo: string, dir: string, mountId: string }): ReadOnlyCheck {
    const mounts = new Map(mountinfo.split('\n').map(parseMountLine).filter((mount): mount is Mount => !isNil(mount)).map((mount) => [mount.id, mount]))
    const holding = mounts.get(mountId)
    if (isNil(holding)) {
        return { readOnly: false, reason: `${NOT_READ_ONLY} (its mount is not in the mount table)` }
    }
    if (!holding.readOnly) {
        return { readOnly: false, reason: NOT_READ_ONLY }
    }
    const writableInside = [...mounts.values()].some((mount) => mount.id !== holding.id
        && !mount.readOnly
        && isAtOrBelow({ dir, target: mount.mountPoint })
        && descendsFrom({ mount, ancestorId: holding.id, mounts }))
    return writableInside ? { readOnly: false, reason: 'a mount inside the qadam version store is not read-only' } : { readOnly: true }
}

function descendsFrom({ mount, ancestorId, mounts }: { mount: Mount, ancestorId: string, mounts: Map<string, Mount> }): boolean {
    const seen = new Set<string>([mount.id])
    let parentId = mount.parentId
    while (!seen.has(parentId)) {
        if (parentId === ancestorId) {
            return true
        }
        seen.add(parentId)
        const parent = mounts.get(parentId)
        if (isNil(parent)) {
            return false
        }
        parentId = parent.parentId
    }
    return false
}

async function fromAccess({ dirs }: { dirs: string[] }): Promise<ReadOnlyCheck> {
    for (const [index, dir] of dirs.entries()) {
        const { error } = await tryCatch(() => access(dir, constants.W_OK))
        const code = errorCode({ error })
        // The namespace directories may not exist yet; the root must.
        if (index > 0 && code === 'ENOENT') {
            continue
        }
        if (code !== 'EROFS') {
            return { readOnly: false, reason: NOT_READ_ONLY }
        }
    }
    return { readOnly: true }
}

function namespaceDirs({ dir }: { dir: string }): string[] {
    const qadamsDir = path.join(dir, QADAM_VERSION_STORE_LAYOUT.qadamsDir)
    return [dir, qadamsDir, path.join(qadamsDir, QADAM_VERSION_STORE_LAYOUT.platformNamespaceDir)]
}

// `<id> <parent> <major:minor> <root> <mount point> <mount options> [optional fields] - <type> <source> <super options>`
function parseMountLine(line: string): Mount | null {
    const fields = line.split(' ')
    const separator = fields.indexOf('-', 6)
    const [id, parentId] = fields
    const mountPoint = fields[4]
    const mountOptions = fields[5]
    if (separator < 0 || isNil(id) || isNil(parentId) || isNil(mountPoint) || isNil(mountOptions)) {
        return null
    }
    const superOptions = fields[separator + 3] ?? ''
    return {
        id,
        parentId,
        mountPoint: unescapeMountField(mountPoint),
        readOnly: mountOptions.split(',').includes('ro') || superOptions.split(',').includes('ro'),
    }
}

// The kernel writes a space, tab, newline or backslash in a path as a three-digit octal escape.
function unescapeMountField(field: string): string {
    return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function isAtOrBelow({ dir, target }: { dir: string, target: string }): boolean {
    const relative = path.relative(dir, target)
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function errorCode({ error }: { error: unknown }): string | null {
    return error instanceof Error && 'code' in error ? String(error.code) : null
}

type Mount = {
    id: string
    parentId: string
    mountPoint: string
    readOnly: boolean
}

type MountIdResult = { ok: true, id: string } | { ok: false, reason: string }

export type ReadOnlyCheck = { readOnly: true } | { readOnly: false, reason: string }
