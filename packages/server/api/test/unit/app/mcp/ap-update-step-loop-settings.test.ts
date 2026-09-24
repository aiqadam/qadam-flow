import {
    FlowActionType,
    FlowTriggerType,
    LoopKeepBodies,
    McpServerType,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        update: mockUpdate,
        list: vi.fn(),
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: vi.fn().mockResolvedValue({ platformId: 'platform-1' }),
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        getOrThrow: vi.fn(),
    })),
}))

import { apUpdateStepTool } from '../../../../src/app/mcp/tools/ap-update-step'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function flow(): Record<string, unknown> {
    return {
        id: 'flow-1',
        publishedVersionId: null,
        version: {
            id: 'fv-1',
            displayName: 'Loop Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Trigger',
                valid: true,
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'loop',
                    displayName: 'Loop',
                    valid: true,
                    type: FlowActionType.LOOP_ON_ITEMS,
                    settings: { items: '{{trigger.output.items}}' },
                    firstLoopAction: {
                        name: 'inside',
                        displayName: 'Inside',
                        valid: true,
                        type: FlowActionType.CODE,
                        settings: { sourceCode: { code: 'export const code = async () => 1', packageJson: '{}' }, input: {} },
                    },
                },
            },
        },
    }
}

// #41: the collector is set through MCP the same way the builder sets it.
describe('ap_update_step — loop collect and keepBodies', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOnePopulated.mockResolvedValue(flow())
        mockUpdate.mockImplementation(() => Promise.resolve(flow()))
    })

    it('writes collect and keepBodies onto a loop step', async () => {
        await apUpdateStepTool(mcp, log).execute({
            flowId: 'flow-1',
            stepName: 'loop',
            loopCollect: { value: '{{inside.value}}', skipFailed: true },
            loopKeepBodies: LoopKeepBodies.FAILED_ONLY,
        })

        const settings = mockUpdate.mock.calls[0][0].operation.request.settings
        // The value is rewritten to the canonical reference form, as `loopItems` and `input` are.
        expect(settings.collect).toEqual({ value: '{{inside[\'output\'].value}}', skipFailed: true })
        expect(settings.keepBodies).toBe(LoopKeepBodies.FAILED_ONLY)
        expect(settings.items).toBe('{{trigger.output.items}}')
    })

    it('refuses them on a step that is not a loop, and writes nothing', async () => {
        const result = await apUpdateStepTool(mcp, log).execute({
            flowId: 'flow-1',
            stepName: 'inside',
            loopCollect: { value: '{{inside}}' },
        })

        expect((result.content?.[0] as { text: string }).text).toContain('can only be set on LOOP_ON_ITEMS steps')
        expect(mockUpdate).not.toHaveBeenCalled()
    })
})
