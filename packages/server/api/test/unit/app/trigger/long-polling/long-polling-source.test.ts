import { FlowStatus, FlowTriggerType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventPullerRegistry } from '../../../../../src/app/trigger/long-polling/event-puller-registry'
import { longPollingSourceRegistry } from '../../../../../src/app/trigger/long-polling/long-polling-source'

const QADAM_NAME = '@aiqadam/qadam-telegram-bot'

const triggerSourceFind = vi.fn()
const flowVersionFind = vi.fn()
const migrate = vi.fn()
const connectionFind = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: () => () => ({ find: triggerSourceFind }),
}))

vi.mock('../../../../../src/app/app-connection/app-connection-service/app-connection-service', () => ({
    appConnectionsRepo: () => ({ find: connectionFind }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionRepo: () => ({ find: flowVersionFind }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version-migration.service', () => ({
    flowVersionMigrationService: () => ({ migrate }),
}))

const mockLog = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
} as unknown as FastifyBaseLogger

function triggerSource(overrides: Record<string, unknown> = {}) {
    return {
        id: 'ts1',
        created: '2026-01-01T00:00:00.000Z',
        flowId: 'flow1',
        flowVersionId: 'fv1',
        projectId: 'project1',
        qadamName: QADAM_NAME,
        simulate: false,
        flow: { status: FlowStatus.ENABLED },
        ...overrides,
    }
}

function flowVersion(overrides: Record<string, unknown> = {}) {
    return {
        id: 'fv1',
        trigger: {
            type: FlowTriggerType.PIECE,
            settings: {
                qadamName: QADAM_NAME,
                input: {
                    auth: '{{connections[\'telegram\']}}',
                    transport: 'long_polling',
                },
            },
        },
        ...overrides,
    }
}

describe('longPollingSourceRegistry.list', () => {
    // The real registry and the real Telegram puller, so `isEnabledFor` is exercised end to end
    // rather than stubbed into agreeing with the fixture.
    beforeAll(async () => {
        await eventPullerRegistry.load()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        triggerSourceFind.mockResolvedValue([])
        flowVersionFind.mockResolvedValue([])
        migrate.mockImplementation(async (flowVersion: unknown) => flowVersion)
        // The delivery mode lives on the connection now, so the registry reads it from there.
        connectionFind.mockResolvedValue([{
            externalId: 'telegram',
            projectIds: ['project1'],
            metadata: { transport: 'long_polling' },
        }])
    })

    it('resolves a source down to its credential', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])

        const { sources } = await longPollingSourceRegistry(mockLog).list()

        expect(sources).toHaveLength(1)
        expect(sources[0]).toMatchObject({
            key: `${QADAM_NAME}|project1|telegram`,
            projectId: 'project1',
            flowId: 'flow1',
            connectionExternalId: 'telegram',
        })
    })

    it('only asks the database for qadams that have a puller', async () => {
        await longPollingSourceRegistry(mockLog).list()

        expect(triggerSourceFind).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ simulate: false }),
        }))
        const [{ where }] = triggerSourceFind.mock.calls[0]
        expect(where.qadamName.value).toEqual(eventPullerRegistry.qadamNames())
    })

    it('asks the database only for enabled flows, rather than filtering afterwards', async () => {
        await longPollingSourceRegistry(mockLog).list()

        const [{ where }] = triggerSourceFind.mock.calls[0]
        expect(where.flow).toEqual({ status: FlowStatus.ENABLED })
    })

    it('ignores a trigger whose connection does not ask for pulling', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])
        connectionFind.mockResolvedValue([{
            externalId: 'telegram',
            projectIds: ['project1'],
            metadata: { transport: 'webhook' },
        }])

        expect((await longPollingSourceRegistry(mockLog).list()).sources).toEqual([])
    })

    it('ignores a trigger whose connection says nothing about delivery', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])
        connectionFind.mockResolvedValue([{ externalId: 'telegram', projectIds: ['project1'], metadata: null }])

        expect((await longPollingSourceRegistry(mockLog).list()).sources).toEqual([])
    })

    // The registry must match a connection on its own project, not on the externalId alone.
    it('does not take the delivery mode from another project\'s connection', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])
        connectionFind.mockResolvedValue([{
            externalId: 'telegram',
            projectIds: ['someone-else'],
            metadata: { transport: 'long_polling' },
        }])

        expect((await longPollingSourceRegistry(mockLog).list()).sources).toEqual([])
    })

    it('ignores a trigger with no connection', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion({
            trigger: {
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: QADAM_NAME,
                    input: { transport: 'long_polling' },
                },
            },
        })])

        expect((await longPollingSourceRegistry(mockLog).list()).sources).toEqual([])
        expect(mockLog.warn).toHaveBeenCalled()
    })

    // `migrate` throws and pages on-call when a flow version cannot be brought up to date. One bad
    // row must not take reconciliation down for every other tenant on the instance.
    it('drops only the source whose flow version cannot be migrated', async () => {
        triggerSourceFind.mockResolvedValue([
            triggerSource({ id: 'broken', flowId: 'broken-flow', flowVersionId: 'fv-broken' }),
            triggerSource({ id: 'fine', flowId: 'fine-flow', flowVersionId: 'fv-fine' }),
        ])
        flowVersionFind.mockResolvedValue([flowVersion({ id: 'fv-broken' }), flowVersion({ id: 'fv-fine' })])
        migrate.mockImplementation(async (version: { id: string }) => {
            if (version.id === 'fv-broken') {
                throw new Error('no migration path')
            }
            return version
        })

        const { sources } = await longPollingSourceRegistry(mockLog).list()

        expect(sources.map((item) => item.flowId)).toEqual(['fine-flow'])
        expect(mockLog.error).toHaveBeenCalled()
    })

    it('drops a source whose puller throws while classifying it, rather than failing the sweep', async () => {
        const puller = eventPullerRegistry.get(QADAM_NAME)
        expect(puller).toBeDefined()
        const isEnabledFor = vi.spyOn(puller!, 'isEnabledFor').mockImplementation(() => {
            throw new Error('the qadam blew up')
        })
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])

        try {
            expect((await longPollingSourceRegistry(mockLog).list()).sources).toEqual([])
            expect(mockLog.error).toHaveBeenCalled()
        }
        finally {
            isEnabledFor.mockRestore()
        }
    })

    // Returned rather than reported from here: the registry is a query, and writing the status
    // from inside it dragged the Redis client into these tests' import graph.
    it('reports the starved flow as a value the host can act on', async () => {
        triggerSourceFind.mockResolvedValue([
            triggerSource({ id: 'old', flowId: 'older', flowVersionId: 'fv1', created: '2026-01-01T00:00:00.000Z' }),
            triggerSource({ id: 'new', flowId: 'newer', flowVersionId: 'fv2', created: '2026-02-01T00:00:00.000Z' }),
        ])
        flowVersionFind.mockResolvedValue([flowVersion(), flowVersion({ id: 'fv2' })])

        const { sources, starved } = await longPollingSourceRegistry(mockLog).list()

        expect(sources.map((item) => item.flowId)).toEqual(['newer'])
        expect(starved.map((item) => item.flowId)).toEqual(['older'])
    })

    it('serves only the most recently enabled flow when two share a credential', async () => {
        triggerSourceFind.mockResolvedValue([
            triggerSource({ id: 'old', flowId: 'older', flowVersionId: 'fv1', created: '2026-01-01T00:00:00.000Z' }),
            triggerSource({ id: 'new', flowId: 'newer', flowVersionId: 'fv2', created: '2026-02-01T00:00:00.000Z' }),
        ])
        flowVersionFind.mockResolvedValue([flowVersion(), flowVersion({ id: 'fv2' })])

        const { sources } = await longPollingSourceRegistry(mockLog).list()

        expect(sources).toHaveLength(1)
        expect(sources[0].flowId).toBe('newer')
        expect(mockLog.warn).toHaveBeenCalled()
    })
})
