import {
    FlowActionType,
    FlowTriggerType,
    McpServerType,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
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

import { apFlowStructureTool } from '../../../../src/app/mcp/tools/ap-flow-structure'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: null } as unknown as ProjectScopedMcpServer
const HEALTHY_VERSION = '0.4.14'
const DEAD_VERSION = '0.0.1-gone'

function pieceStep({ name, qadamVersion, skip, nextAction }: {
    name: string
    qadamVersion: string
    skip?: boolean
    nextAction?: unknown
}) {
    return {
        name,
        displayName: 'Send Email',
        valid: true,
        type: FlowActionType.PIECE,
        ...(skip ? { skip: true } : {}),
        settings: {
            qadamName: '@aiqadam/qadam-test-email',
            qadamVersion,
            actionName: 'send_email',
            input: {},
        },
        nextAction,
    }
}

function flowWith({ firstAction }: { firstAction?: unknown }) {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Structure Flow',
            notes: [],
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: true,
                type: 'EMPTY',
                settings: {},
                nextAction: firstAction,
            },
        },
    }
}

function emptyTriggerFlow() {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Empty Flow',
            notes: [],
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: false,
                type: FlowTriggerType.EMPTY,
                settings: {},
            },
        },
    }
}

async function callTool() {
    return apFlowStructureTool(mcp, log).execute({ flowId: 'flow-1' })
}

describe('ap_flow_structure — pinned qadam version visibility (#474)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockImplementation(async ({ version }: { version: string }) =>
            version === HEALTHY_VERSION ? { name: '@aiqadam/qadam-test-email', version } : undefined)
    })

    it('flags a step pinned to a version this installation does not have', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({ firstAction: pieceStep({ name: 'step_1', qadamVersion: DEAD_VERSION }) }))

        const result = await callTool()

        const text = (result.content?.[0] as { text: string }).text
        expect(text).toContain('PINNED VERSION UNAVAILABLE')
        expect(text).toContain(`@aiqadam/qadam-test-email@${DEAD_VERSION}`)
        expect(JSON.stringify(result.structuredContent?.steps)).toContain('"qadamVersionResolvable":false')
    })

    it('says nothing about a step whose pinned version resolves', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({ firstAction: pieceStep({ name: 'step_1', qadamVersion: HEALTHY_VERSION }) }))

        const result = await callTool()

        const text = (result.content?.[0] as { text: string }).text
        expect(text).not.toContain('PINNED VERSION UNAVAILABLE')
        expect(JSON.stringify(result.structuredContent?.steps)).not.toContain('"qadamVersionResolvable":false')
    })

    // The worker provisions every PIECE step regardless of `skip`, so a dead pin on a skipped step
    // must be flagged the same as an un-skipped one — matching `ap_validate_flow`'s own reasoning.
    it('flags a dead pin even when the step is skipped', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({ firstAction: pieceStep({ name: 'step_1', qadamVersion: DEAD_VERSION, skip: true }) }))

        const result = await callTool()

        const text = (result.content?.[0] as { text: string }).text
        expect(text).toContain('PINNED VERSION UNAVAILABLE')
    })

    it('does not resolve a platform or call the qadam metadata service for a flow with no qadam steps', async () => {
        mockGetOnePopulated.mockResolvedValue(emptyTriggerFlow())

        await callTool()

        expect(mockGetPlatformId).not.toHaveBeenCalled()
        expect(mockGet).not.toHaveBeenCalled()
    })

    it('resolves each distinct pin once, not once per step', async () => {
        const firstAction = pieceStep({
            name: 'step_1',
            qadamVersion: HEALTHY_VERSION,
            nextAction: pieceStep({ name: 'step_2', qadamVersion: HEALTHY_VERSION }),
        })
        mockGetOnePopulated.mockResolvedValue(flowWith({ firstAction }))

        await callTool()

        expect(mockGet).toHaveBeenCalledTimes(1)
    })
})
