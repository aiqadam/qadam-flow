import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { frameworkBuildMajor } from '../../../../src/app/qadams/census/framework-build-major'
import { frameworkCensusPolicy } from '../../../../src/app/qadams/census/framework-census-policy'

// ADR-0002 (#803): an official qadam bundled in the image has no `qadam_metadata` row, so its
// framework major is read off the build's own `package.json`.
describe('frameworkBuildMajor (#803)', () => {
    describe('fromPackageJson', () => {
        it('reads `workspace:*` as the major this tree builds', () => {
            const content = packageJson({ dependencies: { '@aiqadam/qadams-framework': 'workspace:*' } })
            expect(frameworkBuildMajor.fromPackageJson({ content })).toBe(frameworkCensusPolicy.currentFrameworkMajor())
        })

        it('reads a version or a range by its lowest version', () => {
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { '@aiqadam/qadams-framework': '1.4.2' } }) })).toBe(1)
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { '@aiqadam/qadams-framework': '^2.1.0' } }) })).toBe(2)
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { '@aiqadam/qadams-framework': '~0.4.15' } }) })).toBe(0)
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { '@aiqadam/qadams-framework': '>=1.0.0 <3.0.0' } }) })).toBe(1)
        })

        it('falls back to peerDependencies', () => {
            const content = packageJson({ peerDependencies: { '@aiqadam/qadams-framework': '^1.0.0' } })
            expect(frameworkBuildMajor.fromPackageJson({ content })).toBe(1)
        })

        it('is unknown when the framework is missing, the range is not semver, or the file is not a package.json', () => {
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { 'left-pad': '1.0.0' } }) })).toBeNull()
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({}) })).toBeNull()
            expect(frameworkBuildMajor.fromPackageJson({ content: packageJson({ dependencies: { '@aiqadam/qadams-framework': 'latest' } }) })).toBeNull()
            expect(frameworkBuildMajor.fromPackageJson({ content: '{ not json' })).toBeNull()
            expect(frameworkBuildMajor.fromPackageJson({ content: JSON.stringify({ dependencies: 'nope' }) })).toBeNull()
            expect(frameworkBuildMajor.fromPackageJson({ content: null })).toBeNull()
        })
    })

    describe('ofBuild', () => {
        let root: string

        beforeAll(async () => {
            root = await mkdtemp(path.join(tmpdir(), 'framework-build-major-'))
        })

        afterAll(async () => {
            await rm(root, { recursive: true, force: true })
        })

        it('reads the build directory\'s package.json', async () => {
            const directoryPath = await buildDirectory({ root, name: 'ranged', content: packageJson({ dependencies: { '@aiqadam/qadams-framework': '^1.2.0' } }) })
            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBe(1)
        })

        it('is unknown when the build has no package.json', async () => {
            const directoryPath = await buildDirectory({ root, name: 'empty', content: null })
            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBeNull()
        })

        // #838: an unreadable build is an answer (`null`), cached like any other, not re-read on
        // every census.
        it('caches an unknown major instead of re-reading the build', async () => {
            const directoryPath = await buildDirectory({ root, name: 'unknown-then-written', content: null })
            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBeNull()

            await writeFile(path.join(directoryPath, 'package.json'), packageJson({ dependencies: { '@aiqadam/qadams-framework': '^3.0.0' } }))

            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBeNull()
        })

        // #838 review: only an answer the build gave is cached. A read that fails for another
        // reason (EMFILE / EAGAIN under load; here EISDIR) is retried on the next census.
        it('does not cache an unknown major caused by a read error other than a missing file', async () => {
            const directoryPath = await buildDirectory({ root, name: 'transient-read-error', content: null })
            await mkdir(path.join(directoryPath, 'package.json'))
            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBeNull()

            await rm(path.join(directoryPath, 'package.json'), { recursive: true })
            await writeFile(path.join(directoryPath, 'package.json'), packageJson({ dependencies: { '@aiqadam/qadams-framework': '^4.0.0' } }))

            expect(await frameworkBuildMajor.ofBuild({ directoryPath })).toBe(4)
        })

        it('treats a build with no directory as compiled in this tree', async () => {
            expect(await frameworkBuildMajor.ofBuild({ directoryPath: undefined })).toBe(frameworkCensusPolicy.currentFrameworkMajor())
        })
    })
})

function packageJson(fields: Record<string, unknown>): string {
    return JSON.stringify({ name: '@aiqadam/qadam-fixture', version: '0.1.0', ...fields })
}

async function buildDirectory({ root, name, content }: { root: string, name: string, content: string | null }): Promise<string> {
    const directoryPath = path.join(root, name)
    await mkdir(directoryPath, { recursive: true })
    if (content !== null) {
        await writeFile(path.join(directoryPath, 'package.json'), content)
    }
    return directoryPath
}
