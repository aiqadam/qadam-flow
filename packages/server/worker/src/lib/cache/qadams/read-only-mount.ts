import { access, constants, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'

// Whether a directory and everything mounted below it are read-only to this process (#779: a
// worker must not be able to write the qadam version store its engines load code from).
//
// The mount table answers it: `/proc/self/mountinfo` names every mount and its options, so the
// mount that holds the directory, and every mount below it, must carry `ro`. It is the only answer
// that holds for any user. `access(W_OK)` is not: Linux (`do_faccessat` in fs/open.c) checks the
// permission bits before it reports a read-only mount, so a worker that is not root gets EACCES on
// a root-owned 0755 store whether or not the mount is read-only, and EACCES also covers a writable
// mount whose subdirectories it can write. Without a mount table (not Linux), only EROFS from
// `access(W_OK)` counts, on the root and on the store's namespace directories.
export const readOnlyMount = {
    check: async ({ dir }: { dir: string }): Promise<ReadOnlyCheck> => {
        const { data: mountinfo, error } = await tryCatch(() => readFile(MOUNTINFO, 'utf8'))
        if (error === null) {
            return fromMountInfo({ mountinfo, dir })
        }
        return fromAccess({ dirs: [dir, path.join(dir, 'qadams'), path.join(dir, 'qadams', '_platform')] })
    },
}

const MOUNTINFO = '/proc/self/mountinfo'
const NOT_READ_ONLY = 'the qadam version store is not on a read-only mount'

function fromMountInfo({ mountinfo, dir }: { mountinfo: string, dir: string }): ReadOnlyCheck {
    const mounts = mountinfo.split('\n').map(parseMountLine).filter((mount): mount is Mount => !isNil(mount))
    // The last of the longest: a later mount on the same point hides the earlier one.
    const holding = mounts
        .filter((mount) => isAtOrBelow({ dir: mount.mountPoint, target: dir }))
        .reduce<Mount | null>((best, mount) => isNil(best) || mount.mountPoint.length >= best.mountPoint.length ? mount : best, null)
    if (isNil(holding) || !holding.readOnly) {
        return { readOnly: false, reason: NOT_READ_ONLY }
    }
    const writableBelow = mounts.some((mount) => mount.mountPoint !== holding.mountPoint && isAtOrBelow({ dir, target: mount.mountPoint }) && !mount.readOnly)
    return writableBelow ? { readOnly: false, reason: 'a mount inside the qadam version store is not read-only' } : { readOnly: true }
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

// `<id> <parent> <major:minor> <root> <mount point> <mount options> [optional fields] - <type> <source> <super options>`
function parseMountLine(line: string): Mount | null {
    const fields = line.split(' ')
    const separator = fields.indexOf('-', 6)
    const mountPoint = fields[4]
    const mountOptions = fields[5]
    if (separator < 0 || isNil(mountPoint) || isNil(mountOptions)) {
        return null
    }
    const superOptions = fields[separator + 3] ?? ''
    return {
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
    mountPoint: string
    readOnly: boolean
}

export type ReadOnlyCheck = { readOnly: true } | { readOnly: false, reason: string }
