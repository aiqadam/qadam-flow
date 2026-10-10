import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    FlowActionType,
    FlowTriggerType,
    FlowVersionState,
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import type { FlowVersion } from '@aiqadam/shared'
import { extractQadamPackages, extractCodeArtifacts, provisionFlowPieces } from '../../../../src/lib/execute/utils/flow-helpers'
import { PieceNotFoundError } from '../../../../src/lib/cache/qadams/qadam-cache'

const mockGetPiece = vi.fn()
const mockProvision = vi.fn()

vi.mock('../../../../src/lib/cache/qadams/qadam-cache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/lib/cache/qadams/qadam-cache')>()
    return {
        ...actual,
        qadamCache: () => ({
            getPiece: mockGetPiece,
        }),
    }
})

vi.mock('../../../../src/lib/cache/provisioner', () => ({
    provisioner: () => ({
        provision: mockProvision,
    }),
}))

function makeFlowVersion(trigger: FlowVersion['trigger']): FlowVersion {
    return {
        id: 'fv-1',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-1',
        displayName: 'Test Flow',
        trigger,
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
}

const qadamTrigger = {
    name: 'trigger_1',
    valid: true,
    displayName: 'Gmail Trigger',
    lastUpdatedDate: '2024-01-01T00:00:00Z',
    type: FlowTriggerType.PIECE as const,
    settings: {
        qadamName: '@aiqadam/qadam-gmail',
        qadamVersion: '0.1.0',
        triggerName: 'new_email',
        input: {},
        propertySettings: {},
    },
}

const qadamAction = {
    name: 'step_1',
    valid: true,
    displayName: 'Slack Action',
    type: FlowActionType.PIECE as const,
    settings: {
        qadamName: '@aiqadam/qadam-slack',
        qadamVersion: '0.2.0',
        actionName: 'send_message',
        input: {},
        propertySettings: {},
    },
}

const codeAction = {
    name: 'step_2',
    valid: true,
    displayName: 'Code Step',
    type: FlowActionType.CODE as const,
    settings: {
        sourceCode: { code: 'export const code = async () => {}', packageJson: '{}' },
        input: {},
    },
}

const mockLog = {} as any
const mockApiClient = {} as any
const mockPlatformId = 'platform-1'

describe('extractQadamPackages', () => {
    beforeEach(() => {
        mockGetPiece.mockReset()
        mockGetPiece.mockImplementation(({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }) => ({
            qadamName,
            qadamVersion,
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
        }))
    })

    it('returns piece packages for piece trigger and piece action', async () => {
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })
        expect(packages).toHaveLength(2)
        expect(packages).toEqual([
            { qadamName: '@aiqadam/qadam-gmail', qadamVersion: '0.1.0', packageType: PackageType.REGISTRY, qadamType: QadamType.OFFICIAL },
            { qadamName: '@aiqadam/qadam-slack', qadamVersion: '0.2.0', packageType: PackageType.REGISTRY, qadamType: QadamType.OFFICIAL },
        ])
    })

    it('returns empty array for flow with no pieces', async () => {
        const fv = makeFlowVersion({
            name: 'trigger_1',
            valid: true,
            displayName: 'Empty Trigger',
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            type: FlowTriggerType.EMPTY,
            settings: {},
            nextAction: { ...codeAction },
        })
        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })
        expect(packages).toEqual([])
    })

    it('returns only piece steps in a mixed flow', async () => {
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: {
                ...codeAction,
                nextAction: { ...qadamAction },
            },
        })
        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })
        expect(packages).toHaveLength(2)
        expect(packages[0].qadamName).toBe('@aiqadam/qadam-gmail')
        expect(packages[1].qadamName).toBe('@aiqadam/qadam-slack')
    })
})

// #779: the engine loads an agent tool's qadam by the tool's own pin, so the worker provisions it.
describe('extractQadamPackages — agent tools', () => {
    function agentStep({ agentTools }: { agentTools: unknown }): FlowVersion['trigger']['nextAction'] {
        return {
            name: 'agent',
            valid: true,
            displayName: 'Agent',
            type: FlowActionType.PIECE as const,
            settings: {
                qadamName: '@aiqadam/qadam-ai',
                qadamVersion: '0.5.0',
                actionName: 'run_agent',
                input: { prompt: 'go', agentTools },
                propertySettings: {},
            },
        }
    }

    function qadamTool({ toolName, qadamName, qadamVersion }: { toolName: string, qadamName: string, qadamVersion: string }): unknown {
        return { type: 'PIECE', toolName, qadamMetadata: { qadamName, qadamVersion, actionName: 'do_it' } }
    }

    function flowWith({ agentTools }: { agentTools: unknown }): FlowVersion {
        return makeFlowVersion({ ...qadamTrigger, nextAction: agentStep({ agentTools }) })
    }

    beforeEach(() => {
        mockGetPiece.mockReset()
        mockGetPiece.mockImplementation(({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }) => ({
            qadamName,
            qadamVersion,
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
        }))
    })

    it('provisions the qadam of every PIECE tool at the tool\'s own pin', async () => {
        const fv = flowWith({
            agentTools: [
                qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.1' }),
                qadamTool({ toolName: 'b', qadamName: '@acme/qadam-custom', qadamVersion: '1.0.0' }),
            ],
        })

        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })

        expect(packages.map((p) => `${p.qadamName}@${p.qadamVersion}`)).toEqual([
            '@aiqadam/qadam-gmail@0.1.0',
            '@aiqadam/qadam-ai@0.5.0',
            '@aiqadam/qadam-tables@0.5.1',
            '@acme/qadam-custom@1.0.0',
        ])
    })

    it('asks once for a pin that a step and a tool share', async () => {
        const fv = flowWith({
            agentTools: [
                qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-ai', qadamVersion: '0.5.0' }),
                qadamTool({ toolName: 'b', qadamName: '@aiqadam/qadam-ai', qadamVersion: '0.5.0' }),
            ],
        })

        await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })

        expect(mockGetPiece).toHaveBeenCalledTimes(2)
    })

    it('keeps two versions of one qadam apart', async () => {
        const fv = flowWith({
            agentTools: [
                qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.0' }),
                qadamTool({ toolName: 'b', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.1' }),
            ],
        })

        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })

        expect(packages.filter((p) => p.qadamName === '@aiqadam/qadam-tables').map((p) => p.qadamVersion)).toEqual(['0.5.0', '0.5.1'])
    })

    it('ignores tools that name no qadam, malformed entries and a run-time value', async () => {
        const fvWithOtherTools = flowWith({
            agentTools: [
                { type: 'FLOW', toolName: 'f', externalFlowId: 'x' },
                { type: 'PIECE', toolName: 'broken' },
                'not-a-tool',
                null,
            ],
        })
        const fvWithVariable = flowWith({ agentTools: '{{trigger.tools}}' })

        expect(await extractQadamPackages({ flowVersion: fvWithOtherTools, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })).toHaveLength(2)
        expect(await extractQadamPackages({ flowVersion: fvWithVariable, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })).toHaveLength(2)
    })

    it('fails provisioning with the tool\'s pin named when the API does not know it', async () => {
        mockGetPiece.mockImplementation(({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }) => {
            if (qadamName === '@aiqadam/qadam-tables') {
                throw new PieceNotFoundError(qadamName, qadamVersion)
            }
            return { qadamName, qadamVersion, packageType: PackageType.REGISTRY, qadamType: QadamType.OFFICIAL }
        })
        mockProvision.mockReset()
        const fv = flowWith({ agentTools: [qadamTool({ toolName: 'a', qadamName: '@aiqadam/qadam-tables', qadamVersion: '0.5.1' })] })

        const result = await provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: { error: vi.fn() } as any,
            apiClient: mockApiClient,
        })

        expect(result).toEqual({ provisioned: false, unavailableQadam: '@aiqadam/qadam-tables@0.5.1', usedBy: 'agent tool of step agent' })
        expect(mockProvision).not.toHaveBeenCalled()
    })
})

describe('extractCodeArtifacts', () => {
    it('returns code artifacts for code action', () => {
        const fv = makeFlowVersion({
            name: 'trigger_1',
            valid: true,
            displayName: 'Empty Trigger',
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            type: FlowTriggerType.EMPTY,
            settings: {},
            nextAction: { ...codeAction },
        })
        const artifacts = extractCodeArtifacts(fv)
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0]).toEqual({
            name: 'step_2',
            sourceCode: { code: 'export const code = async () => {}', packageJson: '{}' },
            flowVersionId: 'fv-1',
            flowVersionState: FlowVersionState.DRAFT,
        })
    })

    it('returns empty array for flow with no code steps', () => {
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const artifacts = extractCodeArtifacts(fv)
        expect(artifacts).toEqual([])
    })

    it('returns correct items for mixed flow', async () => {
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: {
                ...codeAction,
                nextAction: { ...qadamAction },
            },
        })

        const packages = await extractQadamPackages({ flowVersion: fv, platformId: mockPlatformId, log: mockLog, apiClient: mockApiClient })
        const artifacts = extractCodeArtifacts(fv)

        expect(packages).toHaveLength(2)
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].name).toBe('step_2')
    })
})

describe('provisionFlowPieces', () => {
    const mockWarn = vi.fn()
    const mockError = vi.fn()
    const mockLogger = { warn: mockWarn, error: mockError } as any
    const apiClient = {} as any

    beforeEach(() => {
        mockGetPiece.mockReset()
        mockProvision.mockReset()
        mockWarn.mockReset()
        mockError.mockReset()
        mockGetPiece.mockImplementation(({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }) => ({
            qadamName,
            qadamVersion,
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
        }))
        mockProvision.mockResolvedValue(undefined)
    })

    it('returns true when provisioning succeeds', async () => {
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const result = await provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: mockLogger,
            apiClient,
        })
        expect(result).toEqual({ provisioned: true })
        expect(mockError).not.toHaveBeenCalled()
    })

    // #432: this used to ask the API to disable the flow, which fanned out an ON_DISABLE trigger
    // hook that provisioned the same flow, hit the same missing piece and asked for another
    // disable — blocking on the status-change lock until the caller's 60 s timeout unwound it.
    it('reports a missing piece without disabling the flow', async () => {
        mockGetPiece.mockRejectedValue(new PieceNotFoundError('@aiqadam/qadam-tables', '0.3.1'))
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const result = await provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: mockLogger,
            apiClient,
        })
        expect(result).toEqual({ provisioned: false, unavailableQadam: '@aiqadam/qadam-tables@0.3.1', usedBy: 'step trigger_1' })
        expect(mockError).toHaveBeenCalledTimes(1)
        expect(mockError.mock.calls[0][0]).toMatchObject({ flowId: 'flow-1', projectId: 'project-1' })
        expect(String(mockError.mock.calls[0][0].error)).toContain('0.3.1')
    })

    it('throws on transient provisioner errors', async () => {
        mockProvision.mockRejectedValue(new Error('Failed to provision piece'))
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        await expect(provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: mockLogger,
            apiClient,
        })).rejects.toThrow('Failed to provision piece')
        expect(mockError).not.toHaveBeenCalled()
    })
})
