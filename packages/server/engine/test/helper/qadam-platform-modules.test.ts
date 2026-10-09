import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { qadamPlatformModules } from '../../src/lib/helper/qadam-platform-modules'

// #779: the engine uses a store only when it can give every stored version the platform's copy of
// each package it provides, and says which one is missing without naming a path.
describe('qadamPlatformModules.guard', () => {
    it('refuses, naming the package, when the platform\'s copies cannot be found', async () => {
        const repoRoot = process.cwd()
        const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-no-platform-')))
        process.chdir(elsewhere)
        try {
            const guarded = qadamPlatformModules.guard({ storeRoot: path.join(elsewhere, 'store') })

            expect(guarded).toEqual({ ok: false, reason: 'the platform\'s copy of @aiqadam/shared cannot be found' })
        }
        finally {
            process.chdir(repoRoot)
            await fs.rm(elsewhere, { recursive: true, force: true })
        }
    })

    it('resolves every provided package from the working tree', () => {
        expect(qadamPlatformModules.guard({ storeRoot: path.join(os.tmpdir(), 'unused-store') })).toEqual({ ok: true })
    })
})
