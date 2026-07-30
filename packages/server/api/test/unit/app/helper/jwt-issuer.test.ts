import { describe, expect, it } from 'vitest'
import { jwtUtils } from '../../../../src/app/helper/jwt-utils'

const KEY = 'a-test-signing-key'

// #8 renamed the minted issuer from the upstream 'activepieces' to 'qadam-flow'. The
// safety of that change is entirely in the verifier still accepting the old value, so
// that is what these pin. Without them the rename looks like a one-word diff and signs
// out or locks out every holder of a legacy token: 7-day user sessions, engine tokens
// already embedded in queued jobs (30-day default retention), and hand-set
// AP_WORKER_TOKEN values, which `qadam-flow token` mints with `expiresIn: '100y'` and
// therefore never age out. (The compose path self-heals — docker-entrypoint.sh re-mints
// per container start — so it is not the case that motivates this.)
describe('jwt issuer', () => {
    const signWithIssuer = async (issuer: string): Promise<string> => {
        const jwtLibrary = await import('jsonwebtoken')
        return jwtLibrary.default.sign({ sub: 'test' }, KEY, {
            algorithm: 'HS256',
            keyid: '1',
            expiresIn: 60,
            issuer,
        })
    }

    it('mints tokens under the Qadam Flow issuer, not the upstream one', async () => {
        const token = await jwtUtils.sign({ payload: { sub: 'test' }, key: KEY })
        const decoded = jwtUtils.decode<{ iss: string }>({ jwt: token })
        expect(decoded.payload.iss).toBe('qadam-flow')
    })

    it('verifies a token it minted itself', async () => {
        const token = await jwtUtils.sign({ payload: { sub: 'test' }, key: KEY })
        await expect(jwtUtils.decodeAndVerify({ jwt: token, key: KEY })).resolves.toBeDefined()
    })

    // The load-bearing one: delete LEGACY_ISSUER from ACCEPTED_ISSUERS in jwt-utils.ts
    // and this goes red. Every worker token on every existing deployment depends on it.
    it('still verifies a token issued under the legacy activepieces issuer', async () => {
        const token = await signWithIssuer('activepieces')
        await expect(jwtUtils.decodeAndVerify({ jwt: token, key: KEY })).resolves.toBeDefined()
    })

    it('rejects a token from an issuer that is neither', async () => {
        const token = await signWithIssuer('somebody-else')
        await expect(jwtUtils.decodeAndVerify({ jwt: token, key: KEY })).rejects.toThrow()
    })
})
