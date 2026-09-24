import {
    FlowActionType,
    FlowTriggerType,
    McpServerType,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        list: vi.fn().mockResolvedValue({ data: [], next: null, previous: null }),
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: vi.fn().mockResolvedValue('platform-1'),
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ name: '@aiqadam/qadam-data-mapper', version: '0.4.14', actions: {} }),
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function mapStep({ name, nextAction }: { name: string, nextAction?: unknown }): Record<string, unknown> {
    return {
        name,
        displayName: name,
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowActionType.PIECE,
        settings: { qadamName: '@aiqadam/qadam-data-mapper', qadamVersion: '0.4.14', actionName: 'advanced_mapping', input: {}, propertySettings: {} },
        nextAction,
    }
}

function flowWithLoop({ collectValue, afterLoop }: { collectValue: string, afterLoop?: unknown }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Loop Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'loop',
                    displayName: 'Loop',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.LOOP_ON_ITEMS,
                    settings: { items: '{{trigger.output.items}}', collect: { value: collectValue } },
                    firstLoopAction: mapStep({ name: 'inside' }),
                    nextAction: afterLoop,
                },
            },
        },
    }
}

async function templateIssues(): Promise<string[]> {
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    const issues = (result.structuredContent as { issues: { category: string, message: string }[] }).issues
    return issues.filter((issue) => issue.category === 'template_reference').map((issue) => issue.message)
}

// #41: `collect.value` runs at the end of each iteration, so it reads the loop's own body — steps
// that come after the loop in flow order and would be flagged anywhere else.
describe('ap_validate_flow — loop collect references', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('accepts a reference to a step inside the loop', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithLoop({ collectValue: '{{inside.output.value}}' }))

        expect(await templateIssues()).toEqual([])
    })

    it('flags a reference to a step that runs after the loop', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithLoop({ collectValue: '{{after.output.value}}', afterLoop: mapStep({ name: 'after' }) }))

        const issues = await templateIssues()
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('runs after the loop')
    })

    it('flags a reference to a step that does not exist', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithLoop({ collectValue: '{{ghost.output.value}}' }))

        const issues = await templateIssues()
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('does not exist')
    })
})

// #387: an iteration of a CONCURRENT loop cannot pause. The engine refuses the step at run time;
// ap_validate_flow says so before publish.
describe('ap_validate_flow — pausing steps in concurrent loops', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    const delayStep = {
        name: 'wait',
        displayName: 'Wait',
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowActionType.PIECE,
        settings: { qadamName: '@aiqadam/qadam-delay', qadamVersion: '0.4.14', actionName: 'delayFor', input: { unit: 'seconds', delayFor: 60 }, propertySettings: {} },
    }

    const flowWithDelayInLoop = (mode: 'CONCURRENT' | 'SEQUENTIAL'): Record<string, unknown> => {
        const base = flowWithLoop({ collectValue: '{{wait.output}}' }) as { version: { trigger: { nextAction: Record<string, unknown> } } }
        const loop = base.version.trigger.nextAction
        return {
            ...base,
            version: {
                ...base.version,
                trigger: {
                    ...base.version.trigger,
                    nextAction: { ...loop, settings: { items: '{{trigger.output.items}}', execution: { mode } }, firstLoopAction: delayStep },
                },
            },
        }
    }

    const issuesOf = async (category: string): Promise<string[]> => {
        const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
        const issues = (result.structuredContent as { issues: { category: string, message: string }[] }).issues
        return issues.filter((issue) => issue.category === category).map((issue) => issue.message)
    }

    it('flags a step that pauses inside a CONCURRENT loop', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithDelayInLoop('CONCURRENT'))

        const issues = await issuesOf('concurrent_pause')
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('CONCURRENT loop')
    })

    it('says nothing about the same step in a SEQUENTIAL loop', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithDelayInLoop('SEQUENTIAL'))

        expect(await issuesOf('concurrent_pause')).toEqual([])
    })
})
