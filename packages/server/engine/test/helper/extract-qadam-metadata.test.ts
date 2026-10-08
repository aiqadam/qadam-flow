import { ContextVersion } from '@aiqadam/qadams-framework'
import { ExecuteExtractQadamMetadata, PackageType, QadamType } from '@aiqadam/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { qadamHelper } from '../../src/lib/helper/qadam-helper'

const state = vi.hoisted(() => ({
    qadam: {},
}))
vi.mock('../../src/lib/helper/qadam-loader', () => ({
    qadamLoader: {
        loadQadamOrThrow: async () => state.qadam,
        getPackageAlias: () => 'alias',
        getQadamPath: async () => '/tmp/qadam/src/index.js',
    },
}))
vi.mock('@aiqadam/qadams-framework', async (importOriginal) => {
    const original = await importOriginal<typeof import('@aiqadam/qadams-framework')>()
    return {
        ...original,
        qadamTranslation: {
            ...original.qadamTranslation,
            initializeI18n: async () => undefined,
        },
    }
})

const params: ExecuteExtractQadamMetadata = {
    packageType: PackageType.REGISTRY,
    qadamType: QadamType.CUSTOM,
    qadamName: 'custom-qadam',
    qadamVersion: '1.0.0',
    platformId: 'plat-1',
}

describe('extractQadamMetadata context version (#802)', () => {
    afterEach(() => {
        state.qadam = {}
    })

    it('reports what getContextInfo returns, even when metadata() omits contextInfo', async () => {
        state.qadam = {
            authors: [],
            metadata: () => ({ displayName: 'Old', actions: {}, triggers: {} }),
            getContextInfo: () => ({ version: ContextVersion.V1 }),
        }

        const metadata = await qadamHelper.extractQadamMetadata({ devQadams: [], params })

        expect(metadata.contextInfo).toEqual({ version: ContextVersion.V1 })
    })

    it('reports no context info for a qadam that predates getContextInfo', async () => {
        state.qadam = {
            authors: [],
            metadata: () => ({ displayName: 'Older', actions: {}, triggers: {} }),
        }

        const metadata = await qadamHelper.extractQadamMetadata({ devQadams: [], params })

        expect(metadata.contextInfo).toBeUndefined()
    })
})
