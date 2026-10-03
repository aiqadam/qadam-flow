import { AddQadamRequestBody, QadamScope } from '../../../src/lib/automation/qadams/dto/qadam-requests'
import { PackageType } from '../../../src/lib/automation/qadams/qadam'
import { formErrors } from '../../../src/lib/form-errors'

describe('AddQadamRequestBody qadamName', () => {
    it.each([
        ['@acme/qadam-a'],
        ['qadam-a'],
        ['@acme/qadam.a_b~c'],
        ['a'],
        ['~a'],
        ['0-9'],
    ])('accepts %j, inside the npm package-name grammar', (qadamName) => {
        expect(AddQadamRequestBody.safeParse(registryBody({ qadamName })).success).toBe(true)
        expect(AddQadamRequestBody.safeParse(archiveBody({ qadamName })).success).toBe(true)
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
    ])('rejects %j, outside the npm package-name grammar, with an i18n key', (qadamName) => {
        for (const body of [registryBody({ qadamName }), archiveBody({ qadamName })]) {
            const result = AddQadamRequestBody.safeParse(body)
            expect(result.success).toBe(false)
            expect(JSON.stringify(result.error?.issues)).toContain(formErrors.invalidQadamPackageName)
        }
    })
})

function registryBody({ qadamName }: { qadamName: string }): Record<string, unknown> {
    return {
        packageType: PackageType.REGISTRY,
        scope: QadamScope.PLATFORM,
        qadamName,
        qadamVersion: '1.0.0',
    }
}

function archiveBody({ qadamName }: { qadamName: string }): Record<string, unknown> {
    return {
        packageType: PackageType.ARCHIVE,
        scope: QadamScope.PLATFORM,
        qadamName,
        qadamVersion: '1.0.0',
        qadamArchive: { filename: 'qadam.tgz', data: new Uint8Array(), type: 'file' },
    }
}
