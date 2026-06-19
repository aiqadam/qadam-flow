import { assertNotNullOrUndefined } from '../../core/common'
import { ErrorCode, QadamFlowError } from '../../core/common/qadam-flow-error'

/**
 * @param {string} qadamName - starts with `@aiqadam/qadam-`
 * @param {string} qadamVersion - the version of the qadam
 * @returns {string} the package alias for the qadam, e.g. `@aiqadam/qadam-activepieces-0.0.1`
 */
export const getPackageAliasForQadam = (params: GetPackageAliasForQadamParams): string => {
    const { qadamName, qadamVersion } = params
    return `${qadamName}-${qadamVersion}`
}

/**
 * @param {string} alias - e.g. qadam-activepieces or @aiqadam/qadam-activepieces or activepieces or @aiqadam/activepieces
 * @returns {string} the qadam name, e.g. activepieces
 */
export const getQadamNameFromAlias = (alias: string): string => {
    const fullQadamName = alias.startsWith('@') ? alias.split('/').pop() : alias
    assertNotNullOrUndefined(fullQadamName, 'Full qadam name')
    if (fullQadamName.startsWith('qadam-')) {
        return fullQadamName.split('-').slice(1).join('-')
    }
    return fullQadamName
}

/**
 * @param {string} alias - e.g. `@aiqadam/qadam-activepieces-0.0.1`
 * @returns {string} the qadam name, e.g. `@aiqadam/qadam-activepieces`
 */
export const trimVersionFromAlias = (alias: string): string => {
    return alias.split('-').slice(0, -1).join('-')
}



export const extractQadamFromModule = <T>(params: ExtractQadamFromModuleParams): T => {
    const { module, qadamName, qadamVersion } = params
    const exports = Object.values(module)
    const constructors = []
    for (const e of exports) {
        if (e !== null && e !== undefined && e.constructor.name === 'Qadam') {
            return e as T
        }
        constructors.push(e?.constructor?.name)
    }

    throw new QadamFlowError({
        code: ErrorCode.ENTITY_NOT_FOUND,
        params: {
            entityType: 'qadam',
            entityId: qadamName,
            message: `Failed to extract qadam from module (version: ${qadamVersion}), found constructors: ${constructors.join(', ')}`,
            extra: { qadamName, qadamVersion },
        },
    })
}

export { getQadamMajorAndMinorVersion } from './version-utils'

type GetPackageAliasForQadamParams = {
    qadamName: string
    qadamVersion: string
}

type ExtractQadamFromModuleParams = {
    module: Record<string, unknown>
    qadamName: string
    qadamVersion: string
}
export const MAX_KEY_LENGTH_FOR_CORWDIN = 512
