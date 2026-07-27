import { describe, expect, it } from 'vitest'

// THROWAWAY. This file exists to prove the required `Lint + Unit Tests` context
// FAILS when the reusable workflow's suite fails, not just that it passes when
// the suite passes. #64 replaced the inline verify job with a gate job that
// resolves `needs.verify-run.result`; a gate that only ever reports success is
// exactly the "check that verifies nothing" class this repo tracks. Delete this
// file and close the PR once the red conclusion is observed.
describe('deliberate failure', () => {
    it('fails on purpose to exercise the verify gate', () => {
        expect(1).toBe(2)
    })
})
