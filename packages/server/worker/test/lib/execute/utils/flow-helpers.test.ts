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
        const packages = await extractQadamPackages(fv, mockPlatformId, mockLog, mockApiClient)
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
            type: FlowTriggerType.EMPTY,
            settings: {},
            nextAction: { ...codeAction },
        })
        const packages = await extractQadamPackages(fv, mockPlatformId, mockLog, mockApiClient)
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
        const packages = await extractQadamPackages(fv, mockPlatformId, mockLog, mockApiClient)
        expect(packages).toHaveLength(2)
        expect(packages[0].qadamName).toBe('@aiqadam/qadam-gmail')
        expect(packages[1].qadamName).toBe('@aiqadam/qadam-slack')
    })
})

describe('extractCodeArtifacts', () => {
    it('returns code artifacts for code action', () => {
        const fv = makeFlowVersion({
            name: 'trigger_1',
            valid: true,
            displayName: 'Empty Trigger',
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

        const packages = await extractQadamPackages(fv, mockPlatformId, mockLog, mockApiClient)
        const artifacts = extractCodeArtifacts(fv)

        expect(packages).toHaveLength(2)
        expect(artifacts).toHaveLength(1)
        expect(artifacts[0].name).toBe('step_2')
    })
})

describe('provisionFlowPieces', () => {
    const mockDisableFlow = vi.fn()
    const mockWarn = vi.fn()
    const logWithWarn = { warn: mockWarn } as any
    const apiClientWithDisable = { disableFlow: mockDisableFlow } as any

    beforeEach(() => {
        mockGetPiece.mockReset()
        mockProvision.mockReset()
        mockDisableFlow.mockReset()
        mockWarn.mockReset()
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
            log: logWithWarn,
            apiClient: apiClientWithDisable,
        })
        expect(result).toBe(true)
        expect(mockDisableFlow).not.toHaveBeenCalled()
    })

    it('returns false and calls disableFlow when piece metadata is not found', async () => {
        mockGetPiece.mockRejectedValue(new PieceNotFoundError('@aiqadam/qadam-agent', '0.3.7'))
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const result = await provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: logWithWarn,
            apiClient: apiClientWithDisable,
        })
        expect(result).toBe(false)
        expect(mockDisableFlow).toHaveBeenCalledWith({
            flowId: 'flow-1',
            projectId: 'project-1',
        })
    })

    it('throws on transient provisioner errors without disabling the flow', async () => {
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
            log: logWithWarn,
            apiClient: apiClientWithDisable,
        })).rejects.toThrow('Failed to provision piece')
        expect(mockDisableFlow).not.toHaveBeenCalled()
    })

    it('returns false even if disableFlow fails', async () => {
        mockGetPiece.mockRejectedValue(new PieceNotFoundError('@aiqadam/qadam-agent', '0.3.7'))
        mockDisableFlow.mockRejectedValue(new Error('Network error'))
        const mockError = vi.fn()
        const logWithError = { warn: mockWarn, error: mockError } as any
        const fv = makeFlowVersion({
            ...qadamTrigger,
            nextAction: { ...qadamAction },
        })
        const result = await provisionFlowPieces({
            flowVersion: fv,
            platformId: mockPlatformId,
            flowId: 'flow-1',
            projectId: 'project-1',
            log: logWithError,
            apiClient: apiClientWithDisable,
        })
        expect(result).toBe(false)
        expect(mockError).toHaveBeenCalled()
    })
})
