import { PropertyType, QadamPropertyMap } from '@aiqadam/qadams-framework'
import {
    FlowActionType,
    FlowOperationRequest,
    FlowOperationType,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOrThrow = vi.fn()

vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        getOrThrow: mockGetOrThrow,
    })),
}))

import { flowVersionValidationUtil } from '../../../../../src/app/flows/flow-version/flow-version-validator-util'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

// Mirrors the `callFlow` action of `@aiqadam/qadam-subflows`: the DYNAMIC `flowProps` holding the
// child's argument set, and the `executionMode` static dropdown added in #365.
const CALL_FLOW_PROPS = {
    flow: {
        type: PropertyType.DROPDOWN,
        required: true,
        displayName: 'Flow',
        refreshers: [],
        options: async () => ({ options: [] }),
    },
    mode: {
        type: PropertyType.STATIC_DROPDOWN,
        required: true,
        displayName: 'Mode',
        defaultValue: 'simple',
        options: {
            disabled: false,
            options: [
                { label: 'Simple', value: 'simple' },
                { label: 'Advanced', value: 'advanced' },
            ],
        },
    },
    flowProps: {
        type: PropertyType.DYNAMIC,
        required: true,
        displayName: '',
        refreshers: ['flow', 'mode'],
        props: async () => ({}),
    },
    waitForResponse: {
        type: PropertyType.CHECKBOX,
        required: false,
        displayName: 'Wait for Response',
        defaultValue: false,
    },
    executionMode: {
        type: PropertyType.STATIC_DROPDOWN,
        required: true,
        displayName: 'Execution Mode',
        defaultValue: 'queue',
        options: {
            disabled: false,
            options: [
                { label: 'Queue', value: 'queue' },
                { label: 'Inline', value: 'inline' },
            ],
        },
    },
} as unknown as QadamPropertyMap

function callFlowInput(overrides: Record<string, unknown> = {}) {
    return {
        flow: { externalId: 'child-flow', exampleData: {} },
        mode: 'simple',
        flowProps: { payload: { key: 'greeting', lang: 'ru' } },
        waitForResponse: true,
        executionMode: 'inline',
        ...overrides,
    }
}

function updateActionRequest(input: Record<string, unknown>): FlowOperationRequest {
    return {
        type: FlowOperationType.UPDATE_ACTION,
        request: {
            type: FlowActionType.PIECE,
            name: 'step_1',
            displayName: 'Call Flow',
            valid: true,
            settings: {
                qadamName: '@aiqadam/qadam-subflows',
                qadamVersion: '0.4.14',
                actionName: 'callFlow',
                input,
                propertySettings: {},
                errorHandlingOptions: {
                    continueOnFailure: { value: false },
                    retryOnFailure: { value: false },
                },
            },
        },
    } as FlowOperationRequest
}

async function prepare(input: Record<string, unknown>, props: QadamPropertyMap = CALL_FLOW_PROPS) {
    mockGetOrThrow.mockResolvedValue({
        auth: undefined,
        actions: { callFlow: { props, requireAuth: false } },
    })
    const prepared = await flowVersionValidationUtil(log).prepareRequest({
        platformId: 'platform-1',
        userId: null,
        request: updateActionRequest(input),
    })
    const request = prepared.request as { valid: boolean, settings: { input: Record<string, unknown> } }
    return { input: request.settings.input, valid: request.valid }
}

describe('flowVersionValidationUtil.prepareRequest', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('keeps a DYNAMIC prop\'s value untouched when every prop is declared', async () => {
        const { input } = await prepare(callFlowInput())

        expect(input.flowProps).toEqual({ payload: { key: 'greeting', lang: 'ru' } })
    })

    it('keeps an input key the resolved metadata does not declare, instead of erasing it', async () => {
        const propsWithoutExecutionMode = { ...CALL_FLOW_PROPS } as Record<string, unknown>
        delete propsWithoutExecutionMode.executionMode

        const { input, valid } = await prepare(callFlowInput(), propsWithoutExecutionMode as QadamPropertyMap)

        // Before #381 this returned the step with `executionMode` silently gone and `valid: true` —
        // a successful write that discarded the very value the caller had just sent.
        expect(input.executionMode).toBe('inline')
        expect(input.flowProps).toEqual({ payload: { key: 'greeting', lang: 'ru' } })
        expect(valid).toBe(true)
    })

    it('caps the undeclared key names it logs, and logs names only', async () => {
        const manyUndeclared = Object.fromEntries(
            Array.from({ length: 50 }, (_, index) => [`undeclared_${index}`, `secret-value-${index}`]),
        )

        await prepare({ ...callFlowInput(), ...manyUndeclared })

        const warn = vi.mocked(log.warn)
        expect(warn).toHaveBeenCalledTimes(1)
        const [payload] = warn.mock.calls[0] as [{ undeclaredKeys: string[], undeclaredKeyCount: number }]
        expect(payload.undeclaredKeyCount).toBe(50)
        expect(payload.undeclaredKeys).toHaveLength(20)
        expect(JSON.stringify(payload)).not.toContain('secret-value')
    })

    it('marks the step invalid when a static dropdown value is not one of the declared options', async () => {
        const { valid, input } = await prepare(callFlowInput({ executionMode: 'totally-made-up' }))

        expect(valid).toBe(false)
        // The bad value is still stored — rejecting the request outright is the separate discussion
        // #366 and #391 both defer — but the step no longer reads as configured.
        expect(input.executionMode).toBe('totally-made-up')
    })

    it('accepts a declared option value', async () => {
        const { valid } = await prepare(callFlowInput({ executionMode: 'queue' }))

        expect(valid).toBe(true)
    })

    it('accepts a template expression in a static dropdown, which is what dynamic mode stores', async () => {
        const { valid } = await prepare(callFlowInput({ executionMode: '{{ step_1[\'output\'].mode }}' }))

        expect(valid).toBe(true)
    })
})
