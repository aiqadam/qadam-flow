import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    EngineOperationType,
    EngineResponseStatus,
    ERROR_MESSAGES_TO_REDACT,
} from '@aiqadam/shared'
import type { EngineOperation } from '@aiqadam/shared'
import { execute } from '../../src/lib/operations'

describe('execute operation failure logging', () => {
    afterEach(() => {
        // Each case below silences `console.error`; without this each adds a spy that outlives
        // it, and the next test to assert on console output reads through a stack of them.
        vi.restoreAllMocks()
    })

    // The engine redirects `console.error` and blanks any line matching `ERROR_MESSAGES_TO_REDACT`.
    // This path used to log the bare error object, whose rendering carries no marker, so the guard
    // never fired here (#403).
    //
    // Asserted against the string this call site actually emits, not against the constant. A test
    // written from the constant passes whatever the log line says, which is the exact blind spot
    // that let the HttpClient marker drift unnoticed (#399).
    it('emits a first argument the engine will recognise as redactable', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        const response = await execute(
            'definitely-not-an-operation' as unknown as EngineOperationType,
            {} as unknown as EngineOperation,
        )

        expect(response.status).toBe(EngineResponseStatus.INTERNAL_ERROR)
        const first = logged.mock.calls[0]?.[0]
        expect(typeof first).toBe('string')
        expect(ERROR_MESSAGES_TO_REDACT.some((marker) => String(first).includes(marker))).toBe(true)
    })

    // The guard blanks everything behind the marker, so the escaped error must travel as the
    // payload — dropping it here would blindfold the stderr trace of every internal engine failure.
    it('keeps the escaped error behind the marker', async () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

        await execute(
            'definitely-not-an-operation' as unknown as EngineOperationType,
            {} as unknown as EngineOperation,
        )

        expect(logged.mock.calls[0]?.[1]).toBeInstanceOf(Error)
    })
})
