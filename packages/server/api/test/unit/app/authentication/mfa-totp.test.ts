import { mfaTotp } from '../../../../src/app/authentication/mfa/totp'

const STEP_SECONDS = 30

describe('mfaTotp', () => {
    it('round-trips base32 encode/decode', () => {
        const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 255, 254, 128])

        const encoded = mfaTotp.encodeBase32(bytes)
        const decoded = mfaTotp.decodeBase32(encoded)

        expect(decoded).toEqual(bytes)
    })

    it('generates a 20-byte secret as uppercase base32', () => {
        const secret = mfaTotp.generateSecret()

        expect(secret).toMatch(/^[A-Z2-7]+$/)
        expect(mfaTotp.decodeBase32(secret)).toHaveLength(20)
    })

    it('verifies the code for the current step', () => {
        const secret = mfaTotp.generateSecret()
        const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)
        const step = Math.floor(nowMs / 1000 / STEP_SECONDS)
        const code = mfaTotp.generateCode({ secret, step })

        expect(mfaTotp.verify({ secret, code, nowMs })).toBe(step)
    })

    it('accepts a code one step in the past or future (clock-skew window)', () => {
        const secret = mfaTotp.generateSecret()
        const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)
        const step = Math.floor(nowMs / 1000 / STEP_SECONDS)

        const pastCode = mfaTotp.generateCode({ secret, step: step - 1 })
        const futureCode = mfaTotp.generateCode({ secret, step: step + 1 })

        expect(mfaTotp.verify({ secret, code: pastCode, nowMs })).toBe(step - 1)
        expect(mfaTotp.verify({ secret, code: futureCode, nowMs })).toBe(step + 1)
    })

    it('rejects a code two steps outside the window', () => {
        const secret = mfaTotp.generateSecret()
        const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)
        const step = Math.floor(nowMs / 1000 / STEP_SECONDS)

        const tooOld = mfaTotp.generateCode({ secret, step: step - 2 })

        expect(mfaTotp.verify({ secret, code: tooOld, nowMs })).toBeNull()
    })

    it('rejects a code for a different secret', () => {
        const secretA = mfaTotp.generateSecret()
        const secretB = mfaTotp.generateSecret()
        const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0)
        const step = Math.floor(nowMs / 1000 / STEP_SECONDS)
        const code = mfaTotp.generateCode({ secret: secretA, step })

        expect(mfaTotp.verify({ secret: secretB, code, nowMs })).toBeNull()
    })

    it('rejects a malformed code without matching length', () => {
        const secret = mfaTotp.generateSecret()

        expect(mfaTotp.verify({ secret, code: '12345' })).toBeNull()
        expect(mfaTotp.verify({ secret, code: '1234567' })).toBeNull()
    })

    it('builds an otpauth URL carrying the issuer, account name and secret', () => {
        const url = mfaTotp.buildOtpauthUrl({ secret: 'ABCDEFGHIJKLMNOP', accountName: 'user@example.com', issuer: 'Qadam Flow' })

        expect(url).toMatch(/^otpauth:\/\/totp\//)
        expect(url).toContain('secret=ABCDEFGHIJKLMNOP')
        expect(url).toContain('issuer=Qadam')
        expect(decodeURIComponent(url)).toContain('Qadam Flow:user@example.com')
    })
})
