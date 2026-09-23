import {
    FlowActionType,
    FlowTriggerType,
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

function flowWithCodeStep(stepFlags: { skip?: boolean, logInput?: boolean, logOutput?: boolean }) {
    return {
        id: 'flow-1',
        publishedVersionId: null,
        version: {
            id: 'fv-1',
            displayName: 'Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Webhook',
                valid: true,
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Update row',
                    valid: true,
                    type: FlowActionType.CODE,
                    ...stepFlags,
                    settings: {
                        sourceCode: { code: 'export const code = async () => ({})', packageJson: '{}' },
                        input: {},
                        errorHandlingOptions: {},
                    },
                },
            },
        },
    }
}

async function updateStep(args: Record<string, unknown>): Promise<string> {
    const result = await apUpdateStepTool(mcp, log).execute({ flowId: 'flow-1', stepName: 'step_1', ...args })
    return (result.content?.[0] as { text: string }).text
}

function writtenRequest(): Record<string, unknown> {
    return mockUpdate.mock.calls[0][0].operation.request
}

describe('ap_update_step — run-log opt-outs (#505)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUpdate.mockImplementation(() => Promise.resolve(flowWithCodeStep({})))
    })

    it('passes logInput / logOutput through to the UPDATE_ACTION request', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithCodeStep({}))

        const text = await updateStep({ logOutput: false })

        expect(text).toContain('Successfully updated')
        expect(writtenRequest()).toMatchObject({ logOutput: false })
        expect(writtenRequest().logInput).toBeUndefined()
    })

    // `_updateAction` copies `logInput`/`logOutput`/`skip` straight from the request, so before
    // this fix any `ap_update_step` call silently un-redacted (and un-skipped) the step it touched.
    it('keeps the stored opt-outs and skip when the call does not mention them', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithCodeStep({ logInput: false, logOutput: false, skip: true }))

        await updateStep({ displayName: 'Renamed' })

        expect(writtenRequest()).toMatchObject({ displayName: 'Renamed', logInput: false, logOutput: false, skip: true })
    })

    it('lets an explicit true turn logging back on', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithCodeStep({ logOutput: false }))

        await updateStep({ logOutput: true })

        expect(writtenRequest()).toMatchObject({ logOutput: true })
    })
})
