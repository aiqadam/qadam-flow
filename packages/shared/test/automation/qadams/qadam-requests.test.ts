import { AddQadamRequestBody, QadamScope } from '../../../src/lib/automation/qadams/dto/qadam-requests'
import { PackageType } from '../../../src/lib/automation/qadams/qadam'
import { formErrors } from '../../../src/lib/form-errors'

describe('AddQadamRequestBody qadamName', () => {
    it.each([
        ['@acme/qadam-a'],
        ['qadam-a'],
        ['@acme/qadam.a_b-c'],
        ['a'],
        ['0-9'],
    ])('accepts %j, inside the npm package-name grammar', (qadamName) => {
        expect(AddQadamRequestBody.safeParse(registryBody({ qadamName })).success).toBe(true)
        expect(AddQadamRequestBody.safeParse(archiveBody({ qadamName })).success).toBe(true)
    })

    // #879: npm's name limit is 214 characters. The worker treats a longer name as not found, so
    // it must not be storable as a custom qadam in the first place.
    it('accepts a name at npm\'s 214-character limit and rejects one past it', () => {
        expect(AddQadamRequestBody.safeParse(registryBody({ qadamName: 'a'.repeat(214) })).success).toBe(true)
        expect(AddQadamRequestBody.safeParse(archiveBody({ qadamName: 'a'.repeat(214) })).success).toBe(true)

        for (const body of [registryBody({ qadamName: 'a'.repeat(215) }), archiveBody({ qadamName: 'a'.repeat(215) })]) {
            const result = AddQadamRequestBody.safeParse(body)
            expect(result.success).toBe(false)
            expect(JSON.stringify(result.error?.issues)).toContain(formErrors.invalidQadamPackageName)
        }
    })

    it.each([
        [''],
        ['Upper'],
        ['@acme/Upper'],
        ['.a'],
        ['_a'],
        ['@acme'],
        ['@acme/'],
        ['@/a'],
        ['a/b'],
        ['@acme/a/b'],
        ['../a'],
        ['@acme/../a'],
        ['/a'],
        ['a\\b'],
        ['a b'],
        ['a\n'],
        ['~a'],
        ['@acme/a~b'],
    ])('rejects %j, outside the npm package-name grammar, with an i18n key', (qadamName) => {
        for (const body of [registryBody({ qadamName }), archiveBody({ qadamName })]) {
            const result = AddQadamRequestBody.safeParse(body)
            expect(result.success).toBe(false)
            expect(JSON.stringify(result.error?.issues)).toContain(formErrors.invalidQadamPackageName)
        }
    })
})

// ADR-0004: the custom-qadam install schema keeps `x.y.z`. A `-main.<n>` number names an official
// snapshot only, so installing one as a custom qadam stays refused, like any other prerelease.
describe('AddQadamRequestBody qadamVersion', () => {
    it.each([
        ['0.0.1'],
        ['1.0.0'],
        ['12.34.56'],
    ])('accepts the release %j', (qadamVersion) => {
        expect(AddQadamRequestBody.safeParse(registryBody({ qadamVersion })).success).toBe(true)
        expect(AddQadamRequestBody.safeParse(archiveBody({ qadamVersion })).success).toBe(true)
    })

    it.each([
        ['1.0.0-main.5', 'a main snapshot'],
        ['1.0.0-rc.1', 'another prerelease'],
        ['^1.0.0', 'a caret range'],
        ['~1.0.0', 'a tilde range'],
        ['1.0', 'two components'],
        ['01.0.0', 'a leading zero'],
        ['1.0.0\n', 'a trailing newline'],
        ['', 'an empty version'],
    ])('rejects %j (%s)', (qadamVersion) => {
        expect(AddQadamRequestBody.safeParse(registryBody({ qadamVersion })).success).toBe(false)
        expect(AddQadamRequestBody.safeParse(archiveBody({ qadamVersion })).success).toBe(false)
    })
})

function registryBody({ qadamName = 'qadam-a', qadamVersion = '1.0.0' }: { qadamName?: string, qadamVersion?: string }): Record<string, unknown> {
    return {
        packageType: PackageType.REGISTRY,
        scope: QadamScope.PLATFORM,
        qadamName,
        qadamVersion,
    }
}

function archiveBody({ qadamName = 'qadam-a', qadamVersion = '1.0.0' }: { qadamName?: string, qadamVersion?: string }): Record<string, unknown> {
    return {
        packageType: PackageType.ARCHIVE,
        scope: QadamScope.PLATFORM,
        qadamName,
        qadamVersion,
        qadamArchive: { filename: 'qadam.tgz', data: new Uint8Array(), type: 'file' },
    }
}
