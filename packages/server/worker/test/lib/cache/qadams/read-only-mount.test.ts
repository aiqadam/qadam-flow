import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, accessMock, openMock } = vi.hoisted(() => ({ readFileMock: vi.fn(), accessMock: vi.fn(), openMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, readFile: readFileMock, access: accessMock, open: openMock }
})

import { readOnlyMount } from '../../../../src/lib/cache/qadams/read-only-mount'

const STORE = '/var/lib/qadam-flow/qadam-versions'
const FD = 7

beforeEach(() => {
    openMock.mockResolvedValue({ fd: FD, close: vi.fn().mockResolvedValue(undefined) })
})

afterEach(() => {
    readFileMock.mockReset()
    accessMock.mockReset()
    openMock.mockReset()
})

describe('readOnlyMount.check, from the mount the kernel reached', () => {
    it('accepts a store on a read-only mount', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw,relatime'], ['30', '20', STORE, 'ro,relatime']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('accepts a store below a read-only mount point', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw'], ['30', '20', '/var/lib/qadam-flow', 'ro']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('refuses a store on a writable mount, whatever its permission bits', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw'], ['30', '20', STORE, 'rw,relatime']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount' })
    })

    // Both reviewers' reproduction: `ro` at the store, then a writable bind over an ancestor. The
    // longest mount point is still the read-only one, but the path reaches the writable mount.
    it('refuses a writable mount stacked over an ancestor after the store\'s read-only mount', async () => {
        kernelSees({ storeMountId: '40', mounts: [['20', '1', '/', 'rw'], ['30', '20', STORE, 'ro'], ['40', '20', '/var/lib/qadam-flow', 'rw']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount' })
    })

    it('refuses a writable mount nested inside a read-only store', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw'], ['30', '20', STORE, 'ro'], ['31', '30', `${STORE}/qadams/_platform`, 'rw']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'a mount inside the qadam version store is not read-only' })
    })

    it('ignores writable mounts below the store\'s mount but outside the store', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw'], ['30', '20', '/var/lib', 'ro'], ['31', '30', '/var/lib/docker', 'rw']] })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('decodes escaped mount points', async () => {
        kernelSees({ storeMountId: '30', mounts: [['20', '1', '/', 'rw'], ['30', '20', '/srv/qadam\\040store', 'ro'], ['31', '30', '/srv/qadam\\040store/qadams', 'rw']] })

        expect(await readOnlyMount.check({ dir: '/srv/qadam store' })).toEqual({ readOnly: false, reason: 'a mount inside the qadam version store is not read-only' })
    })

    it('refuses when the kernel names a mount the table does not have, or none at all', async () => {
        kernelSees({ storeMountId: '99', mounts: [['20', '1', '/', 'ro']] })
        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount (its mount is not in the mount table)' })

        openMock.mockRejectedValue(errorWithCode('EACCES'))
        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount (the store\'s mount cannot be identified: EACCES)' })
    })
})

describe('readOnlyMount.check, without a mount table', () => {
    it('accepts only EROFS, on the root and on the namespace directories that exist', async () => {
        readFileMock.mockRejectedValue(errorWithCode('ENOENT'))
        accessMock.mockImplementation(async (dir: string) => {
            throw errorWithCode(dir.endsWith('_platform') ? 'ENOENT' : 'EROFS')
        })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
        expect(accessMock.mock.calls.map((call) => call[0])).toEqual([STORE, `${STORE}/qadams`, `${STORE}/qadams/_platform`])
    })

    it.each([
        ['EACCES: permission bits say nothing about the mount', errorWithCode('EACCES')],
        ['no error: the root is writable', null],
    ])('refuses %s, and says why the mount table was not used', async (_label, error) => {
        readFileMock.mockRejectedValue(errorWithCode('ENOENT'))
        accessMock.mockImplementation(async () => {
            if (error !== null) {
                throw error
            }
        })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount (the mount table cannot be read: ENOENT)' })
    })
})

function kernelSees({ storeMountId, mounts }: { storeMountId: string, mounts: [string, string, string, string][] }): void {
    const mountinfo = mounts.map(([id, parentId, mountPoint, options], index) => `${id} ${parentId} 0:${index} / ${mountPoint} ${options} shared:1 - ext4 /dev/sda1 rw`).join('\n') + '\n'
    readFileMock.mockImplementation(async (file: string) => {
        if (file === '/proc/self/mountinfo') {
            return mountinfo
        }
        if (file === `/proc/self/fdinfo/${FD}`) {
            return `pos:\t0\nflags:\t02400000\nmnt_id:\t${storeMountId}\nino:\t1\n`
        }
        throw errorWithCode('ENOENT')
    })
}

function errorWithCode(code: string): Error {
    return Object.assign(new Error(code), { code })
}
