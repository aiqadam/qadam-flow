import {
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
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getOneOrThrow: vi.fn().mockResolvedValue({ platformId: 'platform-1' }),
    })),
}))

vi.mock('../../../../src/app/mcp/tools/mcp-utils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/mcp/tools/mcp-utils')>()
    return {
        mcpUtils: {
            ...actual.mcpUtils,
            resolveLatestQadamVersion: vi.fn().mockResolvedValue({ normalizedPieceName: '@aiqadam/qadam-telegram-bot', qadamVersion: '0.5.0' }),
        },
    }
})

import { apUpdateTriggerTool } from '../../../../src/app/mcp/tools/ap-update-trigger'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function flowWithTrigger(flags: { logOutput?: boolean }) {
    return {
        id: 'flow-1',
        publishedVersionId: null,
        version: {
            id: 'fv-1',
            displayName: 'Flow',
            trigger: {
                name: 'trigger',
                displayName: 'New message',
                valid: true,
                type: FlowTriggerType.PIECE,
                ...flags,
                settings: {
                    qadamName: '@aiqadam/qadam-telegram-bot',
                    qadamVersion: '0.5.0',
                    triggerName: 'new_message',
                    input: { auth: '{{connections[\'tg\']}}' },
                    propertySettings: {},
                },
            },
        },
    }
}

async function updateTrigger(args: Record<string, unknown>): Promise<string> {
    const result = await apUpdateTriggerTool(mcp, log).execute({
        flowId: 'flow-1',
        qadamName: '@aiqadam/qadam-telegram-bot',
        triggerName: 'new_message',
        ...args,
    })
    return (result.content?.[0] as { text: string }).text
}

function writtenRequest(): Record<string, unknown> {
    return mockUpdate.mock.calls[0][0].operation.request
}

describe('ap_update_trigger — trigger payload opt-out (#505)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUpdate.mockImplementation(() => Promise.resolve(flowWithTrigger({})))
    })

    it('passes logOutput through to the UPDATE_TRIGGER request', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithTrigger({}))

        const text = await updateTrigger({ logOutput: false })

        expect(text).toContain('Successfully updated trigger')
        expect(writtenRequest()).toMatchObject({ logOutput: false })
    })

    it('keeps the stored opt-out when the call does not mention it', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithTrigger({ logOutput: false }))

        await updateTrigger({ input: { chat_id: '1' } })

        expect(writtenRequest()).toMatchObject({ logOutput: false })
    })
})
