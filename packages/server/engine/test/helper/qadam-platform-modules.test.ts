import fs from 'fs/promises'
import os from 'os'
import path from 'path'

// #779: the engine uses a store only when it can give every stored version the platform's copy of
// each package it provides, and says which one is missing without naming a path.
// The module caches each package directory it finds, so every test takes a fresh copy: the result
// must not depend on which test ran first, or from which working directory.
async function freshModules(): Promise<typeof import('../../src/lib/helper/qadam-platform-modules').qadamPlatformModules> {
    vi.resetModules()
    return (await import('../../src/lib/helper/qadam-platform-modules')).qadamPlatformModules
}

describe('qadamPlatformModules.guard', () => {
    it('refuses, naming the package, when the platform\'s copies cannot be found', async () => {
        const repoRoot = process.cwd()
        const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-no-platform-')))
        process.chdir(elsewhere)
        try {
            const guarded = (await freshModules()).guard({ storeRoot: path.join(elsewhere, 'store') })

            expect(guarded).toEqual({ ok: false, reason: 'the platform\'s copy of @aiqadam/qadams-framework cannot be found' })
        }
        finally {
            process.chdir(repoRoot)
            await fs.rm(elsewhere, { recursive: true, force: true })
        }
    })

    it('names the one package that is missing', async () => {
        const repoRoot = process.cwd()
        const elsewhere = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'engine-no-common-')))
        await fs.mkdir(path.join(elsewhere, 'packages', 'qadams'), { recursive: true })
        await fs.symlink(path.join(repoRoot, 'packages', 'qadams', 'framework'), path.join(elsewhere, 'packages', 'qadams', 'framework'))
        process.chdir(elsewhere)
        try {
            const guarded = (await freshModules()).guard({ storeRoot: path.join(elsewhere, 'store') })

            expect(guarded).toEqual({ ok: false, reason: 'the platform\'s copy of @aiqadam/qadams-common cannot be found' })
        }
        finally {
            process.chdir(repoRoot)
            await fs.rm(elsewhere, { recursive: true, force: true })
        }
    })

    it('resolves every provided package from the working tree', async () => {
        expect((await freshModules()).guard({ storeRoot: path.join(os.tmpdir(), 'unused-store') })).toEqual({ ok: true })
    })
})
