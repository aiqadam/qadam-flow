import { apId, FAIL_PARENT_ON_FAILURE_HEADER, PARENT_RUN_ID_HEADER } from '@aiqadam/shared'
import { extractHeaderFromRequest, isBinaryContentType } from '../../../../src/app/webhooks/webhook-request-converter'

describe('isBinaryContentType', () => {
    it.each([
        'image/png',
        'image/jpeg',
        'video/mp4',
        'audio/mpeg',
        'application/pdf',
        'application/zip',
        'application/gzip',
        'application/octet-stream',
    ])('should return true for %s', (contentType) => {
        expect(isBinaryContentType(contentType)).toBe(true)
    })

    it.each([
        'application/json',
        'text/plain',
        'text/html',
        'application/xml',
    ])('should return false for %s', (contentType) => {
        expect(isBinaryContentType(contentType)).toBe(false)
    })

    it('should return false for undefined', () => {
        expect(isBinaryContentType(undefined)).toBe(false)
    })

    it('should handle charset suffix', () => {
        expect(isBinaryContentType('image/png; charset=utf-8')).toBe(true)
        expect(isBinaryContentType('application/json; charset=utf-8')).toBe(false)
    })
})

describe('extractHeaderFromRequest', () => {
    it('should extract parentRunId and failParentOnFailure headers', () => {
        const request = {
            headers: {
                [PARENT_RUN_ID_HEADER]: 'run-123',
                [FAIL_PARENT_ON_FAILURE_HEADER]: 'true',
            },
        } as never

        const result = extractHeaderFromRequest(request)
        expect(result.parentRunId).toBe('run-123')
        expect(result.failParentOnFailure).toBe(true)
    })

    it('should return undefined parentRunId when header is missing', () => {
        const request = {
            headers: {},
        } as never

        const result = extractHeaderFromRequest(request)
        expect(result.parentRunId).toBeUndefined()
        expect(result.failParentOnFailure).toBe(false)
    })

    // Pins the `parsedFlowRunId.data !== parentRunId` check in
    // `extractParentWaitpointIdFromBody` (webhook-request-converter.ts): the header names the
    // run the caller claims as parent, and the callbackUrl's own embedded flowRunId must agree —
    // a callbackUrl proving something about a *different* run must never be accepted as this
    // run's proof.
    describe('parentWaitpointId extraction from callbackUrl', () => {
        it('does not extract a waitpoint id when the callbackUrl names a different run than the header', () => {
            const parentRunId = apId()
            const otherRunId = apId()
            const waitpointId = apId()
            const request = {
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRunId,
                },
                body: {
                    data: {},
                    callbackUrl: `https://example.com/api/v1/flow-runs/${otherRunId}/waitpoints/${waitpointId}`,
                },
            } as never

            const result = extractHeaderFromRequest(request)
            expect(result.parentWaitpointId).toBeUndefined()
        })

        it('extracts the waitpoint id from a public API callbackUrl when the run matches', () => {
            const parentRunId = apId()
            const waitpointId = apId()
            const request = {
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRunId,
                },
                body: {
                    data: {},
                    callbackUrl: `https://public.example.com/api/v1/flow-runs/${parentRunId}/waitpoints/${waitpointId}`,
                },
            } as never

            const result = extractHeaderFromRequest(request)
            expect(result.parentWaitpointId).toBe(waitpointId)
        })

        it('extracts the waitpoint id from an internal API callbackUrl when the run matches', () => {
            const parentRunId = apId()
            const waitpointId = apId()
            const request = {
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRunId,
                },
                body: {
                    data: {},
                    callbackUrl: `http://app:80/api/v1/flow-runs/${parentRunId}/waitpoints/${waitpointId}`,
                },
            } as never

            const result = extractHeaderFromRequest(request)
            expect(result.parentWaitpointId).toBe(waitpointId)
        })

        it('extracts the waitpoint id from a /sync callbackUrl when the run matches', () => {
            const parentRunId = apId()
            const waitpointId = apId()
            const request = {
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRunId,
                },
                body: {
                    data: {},
                    callbackUrl: `https://public.example.com/api/v1/flow-runs/${parentRunId}/waitpoints/${waitpointId}/sync`,
                },
            } as never

            const result = extractHeaderFromRequest(request)
            expect(result.parentWaitpointId).toBe(waitpointId)
        })
    })
})
