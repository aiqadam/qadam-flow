import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { JwtAudience, JwtSignAlgorithm, jwtUtils } from '../../../../src/app/helper/jwt-utils'

const SECRET = 'file-token-audience-test-secret'

// GET /v1/files/signed is securityAccess.public(), so for that route the JWT is the only thing
// between an arbitrary token and a file lookup. Before #251 it verified with no audience, and the
// only reason a session or MCP token could not be replayed into it was that neither carries a
// `fileId` claim — the payload shape doing the audience's job by accident. These pin the audience
// itself. They drive jwtUtils rather than the service so they need no database.
describe('signed file-download tokens — #251', () => {
    const signWithAudience = async (audience: JwtAudience): Promise<string> => {
        return jwtUtils.sign({
            payload: { fileId: 'file-1', fileType: 'FLOW_STEP_FILE' },
            key: SECRET,
            algorithm: JwtSignAlgorithm.HS256,
            expiresInSeconds: 60,
            audience,
        })
    }

    it('accepts a token minted for reading a file', async () => {
        const token = await signWithAudience(JwtAudience.FILE_READ)

        await expect(jwtUtils.decodeAndVerify({
            jwt: token, key: SECRET, audience: JwtAudience.FILE_READ,
        })).resolves.toBeDefined()
    })

    // The interesting case: a token that is perfectly valid, carries a fileId, and was minted for
    // something else entirely. Drop the audience from getFileByToken and this is what gets in.
    it.each([JwtAudience.MCP_OAUTH_ACCESS, JwtAudience.USER_INVITATION])(
        'rejects an otherwise-valid token minted for %s',
        async (audience) => {
            const token = await signWithAudience(audience)

            await expect(jwtUtils.decodeAndVerify({
                jwt: token, key: SECRET, audience: JwtAudience.FILE_READ,
            })).rejects.toThrow()
        },
    )

    it('rejects a token minted with no audience at all', async () => {
        const token = await jwtUtils.sign({
            payload: { fileId: 'file-1' }, key: SECRET, algorithm: JwtSignAlgorithm.HS256, expiresInSeconds: 60,
        })

        await expect(jwtUtils.decodeAndVerify({
            jwt: token, key: SECRET, audience: JwtAudience.FILE_READ,
        })).rejects.toThrow()
    })

    // The three above pass whether or not the service asks for the audience, so on their own they
    // would be exactly the kind of check this repo keeps finding: green either way. This one reads
    // the call site, so removing the option turns it red.
    it('getFileByToken pins the FILE_READ audience', () => {
        const source = readFileSync(path.resolve(__dirname, '../../../../src/app/file/file.service.ts'), 'utf-8')
        const body = source.slice(source.indexOf('async getFileByToken'))
        const verifyCall = body.slice(0, body.indexOf('})'))

        expect(verifyCall).toContain('audience: JwtAudience.FILE_READ')
    })
})
