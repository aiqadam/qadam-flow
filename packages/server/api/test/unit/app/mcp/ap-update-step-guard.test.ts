import { PropertyType } from '@aiqadam/qadams-framework'
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
const mockGetOrThrow = vi.fn()
const mockGet = vi.fn()

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
        getOrThrow: mockGetOrThrow,
        get: mockGet,
    })),
}))

import { apUpdateStepTool } from '../../../../src/app/mcp/tools/ap-update-step'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

const CALL_FLOW_PROPS = {
    flow: { type: PropertyType.DROPDOWN, required: true, displayName: 'Flow' },
    flowProps: { type: PropertyType.DYNAMIC, required: true, displayName: '' },
    executionMode: { type: PropertyType.STATIC_DROPDOWN, required: true, displayName: 'Execution Mode' },
}

function flowWithCallFlowStep(input: Record<string, unknown>) {
    return {
        id: 'flow-1',
        publishedVersionId: null,
        version: {
            id: 'fv-1',
            displayName: 'Parent',
            trigger: {
                name: 'trigger',
                displayName: 'Callable Flow',
                valid: true,
                type: FlowTriggerType.PIECE,
                settings: { qadamName: '@aiqadam/qadam-subflows', qadamVersion: '0.4.14', triggerName: 'callableFlow', input: {}, propertySettings: {} },
                nextAction: {
                    name: 'step_1',
                    displayName: 'Call Flow',
                    valid: true,
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: '@aiqadam/qadam-subflows',
                        qadamVersion: '0.4.14',
                        actionName: 'callFlow',
                        input,
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

const STORED_INPUT = {
    flow: { externalId: 'child-flow' },
    flowProps: { payload: { key: 'greeting', lang: 'ru' } },
    executionMode: 'queue',
}

async function updateStep(input: Record<string, unknown>): Promise<string> {
    const result = await apUpdateStepTool(mcp, log).execute({ flowId: 'flow-1', stepName: 'step_1', input })
    return (result.content?.[0] as { text: string }).text
}

describe('ap_update_step — emptied-required-prop guard', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetOnePopulated.mockResolvedValue(flowWithCallFlowStep(STORED_INPUT))
        mockGet.mockResolvedValue({ version: '0.4.14' })
        mockGetOrThrow.mockResolvedValue({
            auth: undefined,
            actions: { callFlow: { props: CALL_FLOW_PROPS, requireAuth: false } },
        })
        mockUpdate.mockImplementation(() => Promise.resolve(flowWithCallFlowStep(STORED_INPUT)))
    })

    it('refuses the update and writes nothing when it would clear a required DYNAMIC sub-field', async () => {
        const text = await updateStep({ flowProps: { payload: {} } })

        expect(text).toContain('would clear required input')
        expect(text).toContain('flowProps.payload')
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('names only the prop, never its value', async () => {
        const text = await updateStep({ flowProps: { payload: {} } })

        expect(text).not.toContain('greeting')
        expect(text).not.toContain('child-flow')
    })

    it('keeps an unmentioned DYNAMIC prop intact on a partial update', async () => {
        const text = await updateStep({ executionMode: 'inline' })

        expect(text).toContain('Successfully updated')
        const written = mockUpdate.mock.calls[0][0].operation.request.settings.input
        expect(written.flowProps).toEqual({ payload: { key: 'greeting', lang: 'ru' } })
        expect(written.executionMode).toBe('inline')
    })

    it('merges into a DYNAMIC prop rather than replacing it', async () => {
        await updateStep({ flowProps: { payload: { key: 'farewell', lang: 'ru' } } })

        const written = mockUpdate.mock.calls[0][0].operation.request.settings.input
        expect(written.flowProps).toEqual({ payload: { key: 'farewell', lang: 'ru' } })
    })

    describe('a step pinned to a version this instance does not have (#843)', () => {
        // A `values`-like DYNAMIC prop, as `qadam-tables`' update_record / upsert_records declare it.
        const INSTALLED_PROPS = {
            table: { type: PropertyType.DROPDOWN, required: true, displayName: 'Table' },
            values: { type: PropertyType.DYNAMIC, required: true, displayName: 'Values' },
            tags: { type: PropertyType.ARRAY, required: false, displayName: 'Tags' },
        }
        const STORED_RECORD_INPUT = { table: 'people', values: { name: 'Ada', age: '36' } }

        beforeEach(() => {
            mockGet.mockResolvedValue(undefined)
            mockGetOnePopulated.mockResolvedValue(flowWithCallFlowStep(STORED_RECORD_INPUT))
            // Mirrors the real service: the pin does not resolve, the installed version does, and only
            // a caller that opts in to the fallback sees it.
            mockGetOrThrow.mockImplementation(({ fallbackToInstalledVersion }: { fallbackToInstalledVersion?: boolean }) => fallbackToInstalledVersion
                ? Promise.resolve({ auth: undefined, actions: { callFlow: { props: INSTALLED_PROPS, requireAuth: false } } })
                : Promise.reject(new Error('qadam_metadata_not_found')))
        })

        it('keeps the stored sub-fields of a DYNAMIC prop on a partial update', async () => {
            const text = await updateStep({ values: { age: '37' } })

            expect(text).toContain('Successfully updated')
            const written = mockUpdate.mock.calls[0][0].operation.request.settings.input
            expect(written.values).toEqual({ name: 'Ada', age: '37' })
        })

        it('refuses an update that would empty a required sub-field, and writes nothing', async () => {
            const text = await updateStep({ values: { name: '' } })

            expect(text).toContain('would clear required input')
            expect(text).toContain('values.name')
            expect(mockUpdate).not.toHaveBeenCalled()
        })

        it('does not write the installed version\'s optional-prop defaults into the step', async () => {
            await updateStep({ table: 'places' })

            const written = mockUpdate.mock.calls[0][0].operation.request.settings.input
            expect(written).toEqual({ table: 'places', values: { name: 'Ada', age: '36' } })
            expect(mockGetOrThrow.mock.calls.some(([params]) => params.fallbackToInstalledVersion !== true)).toBe(true)
        })

        it('tells the agent the step is still pinned to a version nothing can resolve', async () => {
            const text = await updateStep({ executionMode: 'inline' })

            expect(text).toContain('Successfully updated')
            expect(text).toContain('is pinned to')
            expect(text).toContain('@aiqadam/qadam-subflows@0.4.14')
            expect(text).toContain('does not have')
        })

        it('also carries the pin warning when the updated step is still invalid', async () => {
            const stored = flowWithCallFlowStep(STORED_INPUT)
            mockUpdate.mockResolvedValue({
                ...stored,
                version: {
                    ...stored.version,
                    trigger: {
                        ...stored.version.trigger,
                        nextAction: { ...stored.version.trigger.nextAction, valid: false },
                    },
                },
            })

            const text = await updateStep({ executionMode: 'inline' })

            expect(text).toContain('updated but still invalid')
            expect(text).toContain('is pinned to')
            expect(text).toContain('@aiqadam/qadam-subflows@0.4.14')
        })

        it('adds no pin warning when the pin resolves', async () => {
            mockGet.mockResolvedValue({ version: '0.4.14' })

            const text = await updateStep({ executionMode: 'inline' })

            expect(text).not.toContain('is pinned to')
        })
    })

    it('allows overwriting a required prop with a new value', async () => {
        const text = await updateStep({ executionMode: 'inline', flowProps: { payload: { key: 'other' } } })

        expect(text).toContain('Successfully updated')
        expect(mockUpdate).toHaveBeenCalled()
    })
})
