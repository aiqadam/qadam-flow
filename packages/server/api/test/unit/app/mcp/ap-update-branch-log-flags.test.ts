import {
    BranchExecutionType,
    FlowActionType,
    FlowTriggerType,
    McpServerType,
    ProjectScopedMcpServer,
    RouterExecutionType,
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

import { apUpdateBranchTool } from '../../../../src/app/mcp/tools/ap-update-branch'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function flowWithRouterStep(routerFlags: { skip?: boolean, logInput?: boolean, logOutput?: boolean }) {
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
                    name: 'router_1',
                    displayName: 'Router',
                    valid: true,
                    type: FlowActionType.ROUTER,
                    ...routerFlags,
                    settings: {
                        executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
                        branches: [
                            {
                                branchType: BranchExecutionType.CONDITION,
                                branchName: 'Branch 1',
                                conditions: [],
                            },
                            {
                                branchType: BranchExecutionType.FALLBACK,
                                branchName: 'Otherwise',
                            },
                        ],
                    },
                    children: [null, null],
                },
            },
        },
    }
}

async function updateBranch(args: Record<string, unknown>): Promise<string> {
    const result = await apUpdateBranchTool(mcp, log).execute({
        flowId: 'flow-1',
        routerStepName: 'router_1',
        branchIndex: 0,
        ...args,
    })
    return (result.content?.[0] as { text: string }).text
}

function writtenRequest(): Record<string, unknown> {
    return mockUpdate.mock.calls[0][0].operation.request
}

// #505's `_updateAction` finding — `skip`/`logInput`/`logOutput` are copied straight from the
// UPDATE_ACTION request with no fallback to the stored step — was fixed for ap_update_step but
// missed here: ap_update_branch built its UPDATE_ACTION without those three fields at all, so
// every branch edit silently un-skipped and un-redacted the router.
describe('ap_update_branch — carries the router\'s skip/logInput/logOutput forward', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockUpdate.mockImplementation(() => Promise.resolve(flowWithRouterStep({})))
    })

    it('keeps the stored skip and log opt-outs when the call only edits a branch name', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithRouterStep({ skip: true, logInput: false, logOutput: false }))

        const text = await updateBranch({ branchName: 'Renamed' })

        expect(text).toContain('updated')
        expect(writtenRequest()).toMatchObject({ skip: true, logInput: false, logOutput: false })
    })

    it('does not invent skip/logInput/logOutput for a router that never set them', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithRouterStep({}))

        await updateBranch({ branchName: 'Renamed' })

        const request = writtenRequest()
        expect(request.skip).toBeUndefined()
        expect(request.logInput).toBeUndefined()
        expect(request.logOutput).toBeUndefined()
    })
})
