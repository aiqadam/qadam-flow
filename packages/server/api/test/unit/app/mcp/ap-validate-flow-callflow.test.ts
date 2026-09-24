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
const mockGetMetadata = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        list: mockList,
    })),
}))

// `ap_validate_flow` resolves every pinned qadam version so it can report pins this installation
// cannot serve (#432). These fixtures are all about callFlow, so every pin resolves.
vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: vi.fn().mockResolvedValue('platform-1'),
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: mockGetMetadata,
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

// Pins resolve to a version whose metadata carries no `pauses` marker — the pre-#426 case, which
// every check below exercises through the frozen table and the three conditional evaluators.
const PRE_MARKER_METADATA = { name: '@aiqadam/qadam-subflows', version: '0.4.14', actions: {} }

describe('ap_validate_flow — callFlow checks', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockList.mockResolvedValue({ data: [], next: null, previous: null })
        mockGetMetadata.mockResolvedValue(PRE_MARKER_METADATA)
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

    // #387: a durable loop checkpoints by pausing the run, which an inline child cannot do.
    it('flags an inline callFlow whose child holds a durable loop', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWith({
            displayName: 'Parent',
            externalId: 'parent',
            firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
        }))
        mockList.mockResolvedValue({
            data: [flowWith({
                displayName: 'Child',
                externalId: 'child',
                firstAction: {
                    name: 'loop_1',
                    displayName: 'Send to everyone',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.LOOP_ON_ITEMS,
                    settings: { items: '{{trigger.output.items}}', execution: { mode: 'SEQUENTIAL', durable: true } },
                },
            })],
            next: null,
            previous: null,
        })

        const text = await validate()

        expect(text).toContain('Inline Subflows That Pause')
        expect(text).toContain('durable loop')
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

        // Pins the adjacency the original (#480 pre-wrap) assertion checked — that "Grandchild",
        // not "Child", is the flow identified as pausing, immediately before "pauses at" — so a
        // regression that swaps in the wrong flow at that position still fails this test. The
        // pause reason ("a Wait for Approval") lands after the paused step's own `stepDisplayName`
        // in this message, not adjacent to the flow name, so it is asserted separately rather than
        // folded into the same string.
        expect(text).toContain('⟦Grandchild⟧ pauses at')
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

// #426: the pausing fact lives on the action (`pauses` on createAction), read off the pinned
// version's metadata. The frozen table covers only pins predating the marker.
describe('ap_validate_flow — inline_pause reads the action\'s pauses marker (#426)', () => {
    const PARENT_INLINE = flowWith({
        displayName: 'Parent',
        externalId: 'parent',
        firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
    })

    function childWith(step: unknown) {
        return { data: [flowWith({ displayName: 'Child', externalId: 'child', firstAction: step })], next: null, previous: null }
    }

    function metadataWith(actions: Record<string, unknown>) {
        return { name: '@aiqadam/qadam-anything', version: '0.4.14', actions }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOnePopulated.mockResolvedValue(PARENT_INLINE)
    })

    it('flags an action from a qadam this check has never heard of when its metadata declares pauses: true', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-new-chat', actionName: 'ask_and_wait', input: {} })))
        mockGetMetadata.mockResolvedValue(metadataWith({ ask_and_wait: { displayName: 'Ask and wait', pauses: true } }))

        const text = await validate()

        expect(text).toContain('Inline Subflows That Pause')
        expect(text).toContain('Ask and wait')
        expect(text).toContain('always pauses')
    })

    it('reports a conditional action it has no evaluator for as "may pause" instead of assuming safe', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-new-chat', actionName: 'maybe_wait', input: {} })))
        mockGetMetadata.mockResolvedValue(metadataWith({ maybe_wait: { displayName: 'Maybe wait', pauses: 'conditional' } }))

        const text = await validate()

        expect(text).toContain('Inline Subflows That Pause')
        expect(text).toContain('cannot evaluate it, so it may pause')
    })

    it('leaves an unmarked action alone when its metadata carries an actions map without the marker and the table does not list it', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-tables', actionName: 'find_records', input: {} })))
        mockGetMetadata.mockResolvedValue(metadataWith({ find_records: { displayName: 'Find records' } }))

        const text = await validate()

        expect(text).toContain('ready to publish')
    })

    // The #425 grep missed both `request_action_*` actions (they wait through a shared helper);
    // for a pin predating the marker the frozen table is the only thing that can still catch them.
    it('falls back to the frozen table for a pin whose metadata predates the marker', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-slack', actionName: 'request_action_message', input: {} })))
        mockGetMetadata.mockResolvedValue(metadataWith({ request_action_message: { displayName: 'Request Action in A Channel' } }))

        const text = await validate()

        expect(text).toContain('a Slack action request')
    })

    it('falls back to the frozen table when the metadata lookup fails', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-approval', actionName: 'wait_for_approval', input: {} })))
        mockGetMetadata.mockRejectedValue(new Error('pool exhausted'))

        const text = await validate()

        expect(text).toContain('a Wait for Approval')
    })

    it('does not build a second table: a marked action is judged by the marker even when the table also lists it', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({ name: 'step_1', qadamName: '@aiqadam/qadam-approval', actionName: 'wait_for_approval', input: {} })))
        mockGetMetadata.mockResolvedValue(metadataWith({ wait_for_approval: { displayName: 'Wait for Approval', pauses: true } }))

        const text = await validate()

        expect(text).toContain('always pauses')
    })

    it('resolves each distinct pin once across the whole call graph', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({
            name: 'step_1', qadamName: '@aiqadam/qadam-tables', actionName: 'find_records', input: {},
            nextAction: qadamStep({ name: 'step_2', qadamName: '@aiqadam/qadam-tables', actionName: 'find_records', input: {} }),
        })))
        mockGetMetadata.mockResolvedValue(metadataWith({ find_records: { displayName: 'Find records' } }))

        await validate()

        // One pin (`@aiqadam/qadam-tables@0.4.14`) for the two steps, plus the parent's own pin
        // resolutions for the `qadam_version` category — never one call per step.
        const markerLookups = mockGetMetadata.mock.calls.filter(([args]) => args.name === '@aiqadam/qadam-tables')
        expect(markerLookups).toHaveLength(1)
    })
})

// The second gap #426 names: the conditional cases read their Checkbox as a literal, and did not
// even agree with each other on which literals count. Now one reader, one policy — a template is
// reported, a literal is parsed the same way for both.
describe('ap_validate_flow — conditional pause props read consistently (#426)', () => {
    const PARENT_INLINE = flowWith({
        displayName: 'Parent',
        externalId: 'parent',
        firstAction: callFlowStep({ name: 'step_1', externalId: 'child', executionMode: 'inline', payload: { key: 'greeting' } }),
    })

    function childWith(step: unknown) {
        return { data: [flowWith({ displayName: 'Child', externalId: 'child', firstAction: step })], next: null, previous: null }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOnePopulated.mockResolvedValue(PARENT_INLINE)
        mockGetMetadata.mockResolvedValue(PRE_MARKER_METADATA)
    })

    it('reports a template-bound wait_until_ready rather than assuming it is off', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({
            name: 'step_1', qadamName: '@aiqadam/qadam-assemblyai', actionName: 'transcribe',
            input: { wait_until_ready: '{{trigger[\'output\'].wait}}' },
        })))

        const text = await validate()

        expect(text).toContain('not known until run time, so it may pause')
    })

    it('reads the string literal "true" on waitForResponse the way it already read it on wait_until_ready', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({
            name: 'step_1', qadamName: '@aiqadam/qadam-subflows', actionName: 'callFlow',
            input: { flow: { externalId: 'grandchild' }, executionMode: 'queue', flowProps: { payload: {} }, waitForResponse: 'true' },
        })))

        const text = await validate()

        expect(text).toContain('Queue-mode Call Flow that waits')
    })

    it('reports a template-bound waitForResponse on a Queue-mode callFlow', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({
            name: 'step_1', qadamName: '@aiqadam/qadam-subflows', actionName: 'callFlow',
            input: { flow: { externalId: 'grandchild' }, executionMode: 'queue', flowProps: { payload: {} }, waitForResponse: '{{step_0[\'output\'].wait}}' },
        })))

        const text = await validate()

        expect(text).toContain('"wait for response" is not known until run time')
    })

    it('treats the string literal "false" as off', async () => {
        mockList.mockResolvedValue(childWith(qadamStep({
            name: 'step_1', qadamName: '@aiqadam/qadam-assemblyai', actionName: 'transcribe',
            input: { wait_until_ready: 'false' },
        })))

        const text = await validate()

        expect(text).toContain('ready to publish')
    })
})
