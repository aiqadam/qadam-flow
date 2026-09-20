import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import { PackageType, QadamType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { qadamCache } from '../../../../src/app/qadams/metadata/qadam-cache'

// `vi.mock` factories are hoisted above every other top-level statement, including a plain
// `const` — a factory that closes over one evaluated in its original position would throw
// "Cannot access before initialization" the moment the mocked module (imported below) runs its
// own top-level `system.get(...)` call. `vi.hoisted` runs these before that hoisting happens.
//
// `systemGet` defaults to 'test' from the start, not just from `beforeEach`: `qadam-cache.ts`
// reads `system.get(ENVIRONMENT)` into a MODULE-LEVEL constant at import time (the static
// `qadamCache` import below), before any `beforeEach` has run. Anything other than 'test' there
// makes `isTestingEnvironment` false for the rest of the file, which routes every call through
// the module's own `cachedRegistry` memoisation instead of the mocked DB — so a later test would
// silently keep reading the first test's fixture.
const { getRawMany, loadBundledQadams, systemGet, systemGetBoolean } = vi.hoisted(() => ({
    getRawMany: vi.fn(),
    loadBundledQadams: vi.fn(),
    systemGet: vi.fn((..._args: unknown[]) => 'test'),
    systemGetBoolean: vi.fn((..._args: unknown[]): boolean | undefined => undefined),
}))

// `system.get(ENVIRONMENT)` resolving to 'test' makes the module's `isTestingEnvironment` true,
// so `loadPersistedRegistry` re-fetches from the (mocked) DB on every call instead of going
// through the module-level `cachedRegistry` memoisation — exactly what lets each test below set
// its own persisted-row fixture without leaking state into the next one.
//
// Deliberately minimal: only `get`/`getBoolean` are stubbed, because those are the only two
// `system` methods anything reachable from `qadamCache` calls today. If a future change makes
// `qadam-cache.ts` (or anything it imports) call `getOrThrow`/`getNumber`/etc. at import time, this
// mock will make it fail with a plain "is not a function" rather than a message that points here —
// add the missing method to this mock rather than chasing that error somewhere else.
vi.mock('../../../../src/app/helper/system/system', () => ({
    system: {
        get: (...args: unknown[]) => systemGet(...args),
        getBoolean: (...args: unknown[]) => systemGetBoolean(...args),
    },
}))

vi.mock('../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({
        createQueryBuilder: () => queryBuilder(),
    }),
}))

vi.mock('../../../../src/app/qadams/metadata/utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/qadams/metadata/utils')>()
    return {
        ...actual,
        loadBundledQadams: (...args: unknown[]) => loadBundledQadams(...args),
    }
})

function queryBuilder(): ChainableQueryBuilder {
    const builder: ChainableQueryBuilder = {
        select: () => builder,
        addSelect: () => builder,
        getRawMany,
    }
    return builder
}

function bundledQadam({ name, version }: { name: string, version: string }): QadamMetadataModel {
    return {
        name,
        displayName: name,
        logoUrl: '',
        description: '',
        authors: [],
        version,
        actions: {},
        triggers: {},
        contextInfo: undefined,
        projectUsage: 0,
        qadamType: QadamType.OFFICIAL,
        packageType: PackageType.REGISTRY,
    }
}

function persistedRow({ name, version, qadamType = QadamType.CUSTOM, platformId = 'platform_1' }: {
    name: string
    version: string
    qadamType?: QadamType
    platformId?: string
}): { name: string, version: string, qadamType: QadamType, platformId: string } {
    return { name, version, qadamType, platformId }
}

const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

describe('qadamCache.loadRegistry() — bundled/persisted shadowing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        systemGet.mockReturnValue('test')
        systemGetBoolean.mockReturnValue(false)
        loadBundledQadams.mockResolvedValue([])
        getRawMany.mockResolvedValue([])
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED off (default): a persisted row sharing a bundled name is shadowed regardless of its version — today\'s exact behavior', async () => {
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: '@aiqadam/qadam-tables', version: '0.4.5' })])
        getRawMany.mockResolvedValue([persistedRow({ name: '@aiqadam/qadam-tables', version: '0.3.1' })])

        const registry = await qadamCache(logger).loadRegistry()

        const matching = registry.filter((entry) => entry.name === '@aiqadam/qadam-tables')
        expect(matching).toHaveLength(1)
        expect(matching[0].version).toBe('0.4.5')
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED on: a persisted row at a different version than the bundled one survives side by side', async () => {
        systemGetBoolean.mockReturnValue(true)
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: '@aiqadam/qadam-tables', version: '0.4.5' })])
        getRawMany.mockResolvedValue([persistedRow({ name: '@aiqadam/qadam-tables', version: '0.3.1' })])

        const registry = await qadamCache(logger).loadRegistry()

        const versions = registry
            .filter((entry) => entry.name === '@aiqadam/qadam-tables')
            .map((entry) => entry.version)
            .sort()
        expect(versions).toEqual(['0.3.1', '0.4.5'])
    })

    it('OFFICIAL_QADAMS_INSTALL_ENABLED on: a persisted row at the SAME name and version as the bundled one is still shadowed', async () => {
        systemGetBoolean.mockReturnValue(true)
        loadBundledQadams.mockResolvedValue([bundledQadam({ name: '@aiqadam/qadam-tables', version: '0.4.5' })])
        getRawMany.mockResolvedValue([persistedRow({ name: '@aiqadam/qadam-tables', version: '0.4.5' })])

        const registry = await qadamCache(logger).loadRegistry()

        const matching = registry.filter((entry) => entry.name === '@aiqadam/qadam-tables')
        expect(matching).toHaveLength(1)
    })
})

type ChainableQueryBuilder = {
    select: () => ChainableQueryBuilder
    addSelect: () => ChainableQueryBuilder
    getRawMany: () => unknown
}
