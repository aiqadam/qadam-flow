import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: mockGetPlatformId,
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: mockGet,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function flowWithPieceStep({ qadamVersion }: { qadamVersion: string }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Qadam Version Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Send Email',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: '@aiqadam/qadam-test-email',
                        qadamVersion,
                        actionName: 'send_email',
                        input: {},
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

async function validate(): Promise<string> {
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return (result.content?.[0] as { text: string }).text
}

// #474: `ap_validate_flow` and `ap_flow_structure` share their qadam-pin wording via
// `mcpUtils.qadamPinIssue` — this must not regress into two tools giving an agent contradictory
// accounts of the same pin.
describe('ap_validate_flow — qadam pin resolution wording (#474)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
    })

    it('flags a confirmed-missing pin with the assertive wording and its destructive remedy', async () => {
        mockGet.mockResolvedValue(undefined)
        mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion: '0.0.1-gone' }))

        const text = await validate()

        expect(text).toContain('Unavailable Qadam Versions')
        expect(text).toContain('which this installation does not have')
        expect(text).toContain('delete and re-add')
    })

    // Blocking-adjacent finding: a lookup that merely errored must not be worded as a confirmed
    // miss, and must not advise a destructive edit — the same rule `ap_flow_structure` follows.
    it('does not word an errored lookup as a confirmed miss, and does not advise a destructive edit', async () => {
        mockGet.mockRejectedValue(new Error('ECONNRESET'))
        mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion: '0.2.0' }))

        const text = await validate()

        expect(text).toContain('Unavailable Qadam Versions')
        expect(text).toContain('could not confirm right now whether')
        expect(text).not.toContain('which this installation does not have')
        expect(text).not.toContain('delete and re-add')
    })

    it('says nothing about a step whose pinned version resolves', async () => {
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: '0.2.0' })
        mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion: '0.2.0' }))

        const text = await validate()

        expect(text).not.toContain('Unavailable Qadam Versions')
    })
})
