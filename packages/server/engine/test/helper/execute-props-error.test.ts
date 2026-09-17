import { afterEach, describe, expect, it, vi } from 'vitest'
import { PropertyType } from '@aiqadam/qadams-framework'
import { ERROR_MESSAGES_TO_REDACT } from '@aiqadam/shared'
import { qadamHelper } from '../../src/lib/helper/qadam-helper'

const state = vi.hoisted(() => {
    const propsError = new Error('boom')
    return {
        resolve: async () => ({ resolvedInput: {} }),
        getPropOrThrow: async () => ({
            property: {
                type: PropertyType.DROPDOWN,
                displayName: 'prop',
                options: async () => {
                    throw propsError
                },
            },
            qadam: {},
        }),
    }
})
vi.mock('../../src/lib/helper/qadam-loader', () => ({
    qadamLoader: {
        getPropOrThrow: state.getPropOrThrow,
    },
}))
vi.mock('../../src/lib/variables/props-resolver', () => ({
    createPropsResolver: () => ({
        resolve: state.resolve,
    }),
}))

describe('executeProps failure logging', () => {
    afterEach(() => {
        // Each case below silences `console.error`; without this each adds a spy that outlives
        // it, and the next test to assert on console output reads through a stack of them.
        vi.restoreAllMocks()
    })

    // The engine redirects `console.error` and blanks any line matching `ERROR_MESSAGES_TO_REDACT`.
    // This path used to log the bare error object, whose rendering carries no marker, so the guard
    // never fired here either (#403).
    //
    // Asserted against the string this call site actually emits, not against the constant. A test
    // written from the constant passes whatever the log line says, which is the exact blind spot
    // that let the HttpClient marker drift unnoticed (#399).
    it('emits a first argument the engine will recognise as redactable', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        const result = await qadamHelper.executeProps({
            projectId: 'project-1',
            engineToken: 'test-token',
            internalApiUrl: 'http://localhost:3000/',
            publicApiUrl: 'http://localhost:4200/api/',
            timeoutInSeconds: 600,
            platformId: 'plat-1',
            qadamName: 'qadam-name',
            qadamVersion: '0.0.1',
            propertyName: 'prop',
            actionOrTriggerName: 'action',
            input: {},
            sampleData: {},
        })

        expect(result).toEqual({
            type: PropertyType.DROPDOWN,
            options: {
                disabled: true,
                options: [],
                placeholder: 'Throws an error, reconnect or refresh the page',
            },
        })
        const first = logged.mock.calls[0]?.[0]
        expect(typeof first).toBe('string')
        expect(ERROR_MESSAGES_TO_REDACT.some((marker) => String(first).includes(marker))).toBe(true)
    })

    // The guard blanks everything behind the marker, so the escaped error must travel as the
    // payload.
    it('keeps the escaped error behind the marker', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        await qadamHelper.executeProps({
            projectId: 'project-1',
            engineToken: 'test-token',
            internalApiUrl: 'http://localhost:3000/',
            publicApiUrl: 'http://localhost:4200/api/',
            timeoutInSeconds: 600,
            platformId: 'plat-1',
            qadamName: 'qadam-name',
            qadamVersion: '0.0.1',
            propertyName: 'prop',
            actionOrTriggerName: 'action',
            input: {},
            sampleData: {},
        })

        expect(logged.mock.calls[0]?.[1]).toBeInstanceOf(Error)
    })
})
