import {
    FlowActionType,
    FlowTriggerType,
    McpServerType,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockList = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        list: mockList,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function qadamStep({ name, qadamName, actionName, input, nextAction }: {
    name: string
    qadamName: string
    actionName: string
    input: Record<string, unknown>
    nextAction?: unknown
}) {
    return {
        name,
        displayName: name,
        valid: true,
        lastUpdatedDate: '2024-01-01T00:00:00Z',
        type: FlowActionType.PIECE,
        settings: { qadamName, qadamVersion: '0.4.14', actionName, input, propertySettings: {} },
        nextAction,
    }
}

function callFlowStep({ name, externalId, executionMode, payload, waitForResponse, nextAction }: {
    name: string
    externalId: string
    executionMode: string
    payload?: unknown
    waitForResponse?: boolean
    nextAction?: unknown
}) {
    return qadamStep({
        name,
        qadamName: '@aiqadam/qadam-subflows',
        actionName: 'callFlow',
        input: {
            flow: { externalId },
            mode: 'simple',
            flowProps: { payload },
            waitForResponse: waitForResponse ?? false,
            executionMode,
        },
        nextAction,
    })
}

function flowWith({ displayName, externalId, firstAction, sampleData }: {
    displayName: string
    externalId: string
    firstAction?: unknown
    sampleData?: Record<string, unknown>
}) {
    return {
        id: `id-${externalId}`,
        externalId,
        projectId: 'project-1',
        version: {
            id: `fv-${externalId}`,
            displayName,
            trigger: {
                name: 'trigger',
                displayName: 'Callable Flow',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.PIECE,
                settings: {
                    qadamName: '@aiqadam/qadam-subflows',
                    qadamVersion: '0.4.14',
                    triggerName: 'callableFlow',
                    input: { exampleData: { sampleData: sampleData ?? { key: 'greeting' } } },
                    propertySettings: {},
                },
                nextAction: firstAction,
            },
        },
    }
}

function calleeResolving(flows: ReturnType<typeof flowWith>[]) {
    return { data: flows, next: null, previous: null }
}

async function validate(): Promise<string> {
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'parent' })
    return (result.content?.[0] as { text: string }).text
}

describe('ap_validate_flow — callFlow checks', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockList.mockResolvedValue({ data: [], next: null, previous: null })
    })

    it('flags a callFlow step whose payload is empty while the callee declares arguments', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'queue', payload: {} }),
        }))
        mockList.mockResolvedValue(calleeResolving([flowWith({ displayName: 'Child', externalId: 'child' })]))

        const text = await validate()

        expect(text).toContain('Subflow Payloads')
        expect(text).toContain('empty payload')
    })

    it('leaves an empty payload alone when the callee takes no arguments', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'queue', payload: {} }),
        }))
        mockList.mockResolvedValue(calleeResolving([
            flowWith({ displayName: 'Child', externalId: 'child', sampleData: {} }),
        ]))

        const text = await validate()

        expect(text).toContain('ready to publish')
    })

    it('ignores a skipped callFlow step, the way every other check does', async () => {
        const skipped = {
            ...callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: {} }),
            skip: true,
        }
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: skipped,
        }))
        mockList.mockResolvedValue(calleeResolving([
            flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: qadamStep({
                    name: 'step_1',
                    qadamName: '@aiqadam/qadam-approval',
                    actionName: 'wait_for_approval',
                    input: {},
                }),
            }),
        ]))

        const text = await validate()

        expect(text).not.toContain('Subflow Payloads')
        expect(text).not.toContain('Inline Subflows That Pause')
    })

    it('accepts a callFlow step that carries a payload', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'queue', payload: { key: 'greeting' } }),
        }))

        const text = await validate()

        expect(text).toContain('ready to publish')
    })

    it('flags an inline callFlow whose child pauses on a long Delay', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: qadamStep({
                    name: 'step_1',
                    qadamName: '@aiqadam/qadam-delay',
                    actionName: 'delayFor',
                    input: { unit: 'minutes', delayFor: 5 },
                }),
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('Inline Subflows That Pause')
        expect(text).toContain('Delay longer than 10 seconds')
    })

    it('leaves an inline callFlow alone when the child only sleeps in process', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: qadamStep({
                    name: 'step_1',
                    qadamName: '@aiqadam/qadam-delay',
                    actionName: 'delayFor',
                    input: { unit: 'seconds', delayFor: 3 },
                }),
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('ready to publish')
    })

    it('reports a Delay whose duration is a template expression rather than assuming it is short', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: qadamStep({
                    name: 'step_1',
                    qadamName: '@aiqadam/qadam-delay',
                    actionName: 'delayFor',
                    input: { unit: 'seconds', delayFor: '{{ trigger[\'output\'].seconds }}' },
                }),
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('not known until run time')
    })

    it('does not let a prototype-chain unit name suppress the Delay warning', async () => {
        // `DELAY_UNIT_MS['constructor']` returns an inherited function on a bare index, which makes
        // the duration NaN and reports the step as not pausing — the one answer a flow author must
        // not be handed by accident.
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue(calleeResolving([
            flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: qadamStep({
                    name: 'step_1',
                    qadamName: '@aiqadam/qadam-delay',
                    actionName: 'delayFor',
                    input: { unit: 'constructor', delayFor: 5 },
                }),
            }),
        ]))

        const text = await validate()

        expect(text).toContain('not known until run time')
    })

    it('finds a pausing step through a nested inline callFlow', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockImplementation(({ externalIdsOrIds }: { externalIdsOrIds: string[] }) => {
            if (externalIdsOrIds.includes('child')) {
                return Promise.resolve({
                    data: [flowWith({
                        displayName: 'Child',
                        externalId: 'child',
                        firstAction: callFlowStep({ name: 'step_1', externalId: 'grandchild', executionMode: 'inline', payload: { key: 'x' } }),
                    })],
                    next: null,
                    previous: null,
                })
            }
            return Promise.resolve({
                data: [flowWith({
                    displayName: 'Grandchild',
                    externalId: 'grandchild',
                    firstAction: qadamStep({
                        name: 'step_1',
                        qadamName: '@aiqadam/qadam-approval',
                        actionName: 'wait_for_approval',
                        input: {},
                    }),
                })],
                next: null,
                previous: null,
            })
        })

        const text = await validate()

        expect(text).toContain('"Grandchild" pauses')
        expect(text).toContain('Wait for Approval')
    })

    it('does not walk into a Queue-mode child, but does flag waiting on one', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: callFlowStep({
                    name: 'step_1',
                    externalId: 'grandchild',
                    executionMode: 'queue',
                    payload: { key: 'x' },
                    waitForResponse: true,
                }),
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('Queue-mode Call Flow that waits')
        expect(mockList).toHaveBeenCalledTimes(1)
    })

    it('terminates on a call graph that loops back on itself', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'x' } }),
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('ready to publish')
    })

    it('scopes every callee lookup to the caller\'s own project', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))

        await validate()

        expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ projectIds: ['project-1'] }))
    })
})
