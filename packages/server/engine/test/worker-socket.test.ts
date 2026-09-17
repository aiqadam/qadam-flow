import { describe, expect, it } from 'vitest'
import { sanitizeConsoleErrorArgs } from '../src/lib/worker-socket'

describe('sanitizeConsoleErrorArgs', () => {
    it('blanks the payload behind a recognised marker', () => {
        const marker = '[Engine#executeOperation] Operation failed:'
        const error = new Error('boom sk-live-do-not-leak-9f3c1a')

        const sanitized = sanitizeConsoleErrorArgs([marker, error])

        expect(sanitized).toEqual([marker, 'REDACTED'])
        expect(JSON.stringify(sanitized)).not.toContain('sk-live-do-not-leak-9f3c1a')
    })

    it('leaves lines without a recognised marker untouched', () => {
        const error = new Error('boom')

        expect(sanitizeConsoleErrorArgs([error])[0]).toBe(error)
        expect(sanitizeConsoleErrorArgs(['Error sending update:', error])).toEqual(['Error sending update:', error])
        expect(sanitizeConsoleErrorArgs([])).toEqual([])
    })

    // The guard only looks at the first argument: a marker anywhere else changes nothing. This is
    // why failure-payload lines must be emitted marker-first rather than as a bare error object.
    it('ignores a marker outside the first argument', () => {
        const error = new Error('boom')

        expect(sanitizeConsoleErrorArgs([error, '[Engine#executeOperation] Operation failed:'])[0]).toBe(error)
    })
})
