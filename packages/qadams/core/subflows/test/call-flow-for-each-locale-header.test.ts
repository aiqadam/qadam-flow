/// <reference types="vitest/globals" />

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExecutionType, FlowStatus, FlowTriggerType, JoinFailurePolicy, PARENT_RUN_LOCALE_HEADER, PopulatedFlow } from '@aiqadam/shared'

const sendRequest = vi.fn()

vi.mock('@aiqadam/qadams-common', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@aiqadam/qadams-common')>()
    return { ...actual, httpClient: { sendRequest } }
})

const mockFlow = {
    id: 'flow_1',
    externalId: 'flow_1',
    status: FlowStatus.ENABLED,
    version: {
        displayName: 'Child Flow',
        trigger: {
            type: FlowTriggerType.PIECE,
            settings: {
                qadamName: '@aiqadam/qadam-subflows',
                input: { exampleData: { sampleData: {} } },
            },
        },
    },
} as unknown as PopulatedFlow

function buildContext(params: { locale: (() => Promise<string | null>) | undefined }) {
    return {
        executionType: ExecutionType.BEGIN,
        propsValue: {
            flow: { externalId: 'flow_1', exampleData: { sampleData: {} } },
            items: [{ name: 'Alice' }],
            failurePolicy: JoinFailurePolicy.enum.ALL_SETTLED,
            quorum: undefined,
            joinTimeoutSeconds: undefined,
        },
        flows: {
            list: async () => ({ data: [mockFlow], next: null, previous: null }),
        },
        server: {
            apiUrl: 'https://example.invalid/api/',
            publicUrl: 'https://example.invalid/',
            token: 'test-token',
        },
        run: {
            id: 'run_1',
            createWaitpoint: vi.fn().mockResolvedValue({
                slotResumeUrls: ['https://example.invalid/resume/0'],
                dispatchedSlots: [],
            }),
            waitForWaitpoint: vi.fn(),
            // `locale` omitted entirely reproduces an engine older than this qadam's own
            // context.run.locale-forwarding change (#420) - `typeof ... === 'function'` is what
            // this test exists to prove call-flow-for-each.ts guards against.
            ...(params.locale === undefined ? {} : { locale: params.locale }),
        },
    } as unknown as Parameters<typeof import('../src/lib/actions/call-flow-for-each').callFlowForEach.run>[0]
}

describe('callFlowForEach forwards the parent run locale header to each dispatched child', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        sendRequest.mockReset()
        sendRequest.mockResolvedValue({ body: {} })
    })

    it('sends the header when the run has a resolved locale', async () => {
        const { callFlowForEach } = await import('../src/lib/actions/call-flow-for-each')
        const context = buildContext({ locale: async () => 'ru' })

        await callFlowForEach.run(context)

        expect(sendRequest).toHaveBeenCalledTimes(1)
        const call = sendRequest.mock.calls[0][0] as { headers: Record<string, string> }
        expect(call.headers[PARENT_RUN_LOCALE_HEADER]).toBe('ru')
    })

    it('omits the header when the run has no resolved locale', async () => {
        const { callFlowForEach } = await import('../src/lib/actions/call-flow-for-each')
        const context = buildContext({ locale: async () => null })

        await callFlowForEach.run(context)

        const call = sendRequest.mock.calls[0][0] as { headers: Record<string, string> }
        expect(call.headers[PARENT_RUN_LOCALE_HEADER]).toBeUndefined()
    })

    it('omits the header, without throwing, on an engine whose RunContext has no locale hook at all', async () => {
        const { callFlowForEach } = await import('../src/lib/actions/call-flow-for-each')
        const context = buildContext({ locale: undefined })

        await expect(callFlowForEach.run(context)).resolves.toBeDefined()

        const call = sendRequest.mock.calls[0][0] as { headers: Record<string, string> }
        expect(call.headers[PARENT_RUN_LOCALE_HEADER]).toBeUndefined()
    })
})
