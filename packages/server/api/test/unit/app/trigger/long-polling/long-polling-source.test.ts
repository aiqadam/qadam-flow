import { FlowStatus, FlowTriggerType } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventPullerRegistry } from '../../../../../src/app/trigger/long-polling/event-puller-registry'
import { longPollingSourceRegistry } from '../../../../../src/app/trigger/long-polling/long-polling-source'

const QADAM_NAME = '@aiqadam/qadam-telegram-bot'

const triggerSourceFind = vi.fn()
const flowVersionFind = vi.fn()

vi.mock('../../../../../src/app/trigger/trigger-source/trigger-source-service', () => ({
    triggerSourceRepo: () => ({ find: triggerSourceFind }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionRepo: () => ({ find: flowVersionFind }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version-migration.service', () => ({
    flowVersionMigrationService: () => ({ migrate: async (flowVersion: unknown) => flowVersion }),
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
    beforeEach(() => {
        vi.clearAllMocks()
        triggerSourceFind.mockResolvedValue([])
        flowVersionFind.mockResolvedValue([])
    })

    it('resolves a source down to its credential', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion()])

        const sources = await longPollingSourceRegistry(mockLog).list()

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

    it('ignores a trigger whose flow is disabled', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource({ flow: { status: FlowStatus.DISABLED } })])
        flowVersionFind.mockResolvedValue([flowVersion()])

        expect(await longPollingSourceRegistry(mockLog).list()).toEqual([])
    })

    it('ignores a trigger the puller does not claim', async () => {
        triggerSourceFind.mockResolvedValue([triggerSource()])
        flowVersionFind.mockResolvedValue([flowVersion({
            trigger: {
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: QADAM_NAME,
                    input: { auth: '{{connections[\'telegram\']}}', transport: 'webhook' },
                },
            },
        })])

        expect(await longPollingSourceRegistry(mockLog).list()).toEqual([])
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

        expect(await longPollingSourceRegistry(mockLog).list()).toEqual([])
        expect(mockLog.warn).toHaveBeenCalled()
    })

    it('serves only the most recently enabled flow when two share a credential', async () => {
        triggerSourceFind.mockResolvedValue([
            triggerSource({ id: 'old', flowId: 'older', flowVersionId: 'fv1', created: '2026-01-01T00:00:00.000Z' }),
            triggerSource({ id: 'new', flowId: 'newer', flowVersionId: 'fv2', created: '2026-02-01T00:00:00.000Z' }),
        ])
        flowVersionFind.mockResolvedValue([flowVersion(), flowVersion({ id: 'fv2' })])

        const sources = await longPollingSourceRegistry(mockLog).list()

        expect(sources).toHaveLength(1)
        expect(sources[0].flowId).toBe('newer')
        expect(mockLog.warn).toHaveBeenCalled()
    })
})
