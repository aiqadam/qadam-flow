import { afterEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, accessMock } = vi.hoisted(() => ({ readFileMock: vi.fn(), accessMock: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>()
    return { ...actual, readFile: readFileMock, access: accessMock }
})

import { readOnlyMount } from '../../../../src/lib/cache/qadams/read-only-mount'

const STORE = '/var/lib/qadam-flow/qadam-versions'

afterEach(() => {
    readFileMock.mockReset()
    accessMock.mockReset()
})

describe('readOnlyMount.check, from the mount table', () => {
    it('accepts a store on a read-only mount', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw,relatime'], [STORE, 'ro,relatime']]))

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('accepts a store below a read-only mount point', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], ['/var/lib/qadam-flow', 'ro']]))

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('refuses a store on a writable mount, whatever its permission bits', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], [STORE, 'rw,relatime']]))

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount' })
    })

    it('refuses a writable mount nested inside a read-only store', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], [STORE, 'ro'], [`${STORE}/qadams/_platform`, 'rw']]))

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'a mount inside the qadam version store is not read-only' })
    })

    it('reads the mount that hides an earlier one on the same point', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], [STORE, 'rw'], [STORE, 'ro']]))

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
    })

    it('does not take a sibling with a longer name for the store\'s mount', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], [`${STORE}-backup`, 'ro']]))

        expect((await readOnlyMount.check({ dir: STORE })).readOnly).toBe(false)
    })

    it('decodes escaped mount points', async () => {
        readFileMock.mockResolvedValue(mountTable([['/', 'rw'], ['/srv/qadam\\040store', 'ro']]))

        expect(await readOnlyMount.check({ dir: '/srv/qadam store' })).toEqual({ readOnly: true })
    })
})

describe('readOnlyMount.check, without a mount table', () => {
    it('accepts only EROFS, on the root and on the namespace directories that exist', async () => {
        readFileMock.mockRejectedValue(errorWithCode('ENOENT'))
        accessMock.mockImplementation(async (dir: string) => {
            throw errorWithCode(dir.endsWith('_platform') ? 'ENOENT' : 'EROFS')
        })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: true })
        expect(accessMock).toHaveBeenCalledTimes(3)
    })

    it.each([
        ['EACCES: permission bits say nothing about the mount', errorWithCode('EACCES')],
        ['no error: the root is writable', null],
    ])('refuses %s', async (_label, error) => {
        readFileMock.mockRejectedValue(errorWithCode('ENOENT'))
        accessMock.mockImplementation(async () => {
            if (error !== null) {
                throw error
            }
        })

        expect(await readOnlyMount.check({ dir: STORE })).toEqual({ readOnly: false, reason: 'the qadam version store is not on a read-only mount' })
    })
})

function mountTable(mounts: [string, string][]): string {
    return mounts.map(([mountPoint, options], index) => `${index + 20} 1 0:${index} / ${mountPoint} ${options} shared:1 - ext4 /dev/sda1 rw`).join('\n') + '\n'
}

function errorWithCode(code: string): Error {
    return Object.assign(new Error(code), { code })
}
