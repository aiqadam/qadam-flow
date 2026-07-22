import { AddressInfo } from 'node:net'
import {
    DefaultProjectRole,
    InvitationType,
    ProjectWithLimits,
    UserInvitationWithLink,
} from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { SMTPServer } from 'smtp-server'
import { createMockUserIdentity } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { db } from '../../../helpers/db'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIURp0ikp+xBn+VDv1T1yxefzaUVGMwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyMjA5MjMzMFoXDTM2MDcx
OTA5MjMzMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAoeHvEKUVD7vimUCx8Um++p9p52p/CFQSNxa6J9UQD5Kh
K5uv/sz81pFgzCYe1etx+/W45YfXp0Y2vctUb7vvkRWDRtMzbCrZIBJ6MOLVjFyT
pv23S2/3Rm0yhNbZXtAvcQbZF1NV/H0X1Igqb+T2zJCuzIPlITJGsrPgVLddv4Mf
4FkcU+kmf4Sz/xxGcz5JCClhhGm02H2RXXTQwd2M8okQm7ilWzG5rQRPboPk/qSX
buDukD5DvzDBpi2hck2Mcua9B6y+oz/1ZwRJ6aa+J8jlEErXQmOEF9niUHr2vp8u
ijBp+dKsibKgAmftMTvU/v2MklAlp0t9tLbJP95cpwIDAQABo1MwUTAdBgNVHQ4E
FgQUsGBPs8VPaFJ2bT/hUdPpErDheJ4wHwYDVR0jBBgwFoAUsGBPs8VPaFJ2bT/h
UdPpErDheJ4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAlto6
6v/B7DSTXlPSpDEfcya0oE4mdcb7VBOixfEQ7ZZiguKcak7EqaI0Gyed3a7tvcmg
JBLKxe2mOtvWjZS1NX9bdJWcBESdGHLjSNgyQ/CkQO68LrKAqRMWTOUy8LmQhLgM
o2Rjn18oP6ELNlV14nS40YxU/SVvha1A52g1GduTdvbOL+w3AlY+8TbLWHcOPotm
4KiQifd3I/KmjBEpCRFhGUcrfBYTV7tzoVka6ZEsMwBSgPpv4mFbxSJLOH+SpTG+
czsRqFkkKXr6/K8abZYcFCcvJ+WV/Fg6h8b/KsUtUKAlFdJQ0EZ34j+Hqhjx9yWQ
uNfnp78FzZNN3lSUvA==
-----END CERTIFICATE-----`

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCh4e8QpRUPu+KZ
QLHxSb76n2nnan8IVBI3Fron1RAPkqErm6/+zPzWkWDMJh7V63H79bjlh9enRja9
y1Rvu++RFYNG0zNsKtkgEnow4tWMXJOm/bdLb/dGbTKE1tle0C9xBtkXU1X8fRfU
iCpv5PbMkK7Mg+UhMkays+BUt12/gx/gWRxT6SZ/hLP/HEZzPkkIKWGEabTYfZFd
dNDB3YzyiRCbuKVbMbmtBE9ug+T+pJdu4O6QPkO/MMGmLaFyTYxy5r0HrL6jP/Vn
BEnppr4nyOUQStdCY4QX2eJQeva+ny6KMGn50qyJsqACZ+0xO9T+/YySUCWnS320
tsk/3lynAgMBAAECgf9wqaKNHaxgHDgYGxkRqcFrAIc0B2oMNyEg4IWuMxp6ZrzE
chXfvx+Nip/+HzRWrQXR1QcEDQaJOX807SMBSvVFLokD7E5deXSjCDkCIjF8/kZv
HHn0hngRtkLyhenCPXbHCCe46XFuckujc8tqacSu71gNUxNO3IQCMC3FcoL2763h
bKzqZXo+6FFUd3eP4QFa6wD8StNwGL0Iw3VevQpw2H1knmFprccEb8HuV0roOxdt
UK1PEnz/Ze8BNKFBdAGZnfsfKt9+J6wIvVpVPc72Kwr5OirHP+Id3u7AQXxruWq3
RTMfjQclElZoy8GyUX8K1Qw/X39YOBIHfSV8o7ECgYEA5CaD/FtRoTuwVOBUmVGK
0HUt/hQ+BYR4za4TlLUw8xdJsBidio5+9POf4bZ/BM/CA2dsoj8ed6sgu+jvg6Wz
/CRe1cPPRKgsPg0zhyckhDRKCJRQp5sG5rviLzXlrY4ttQvq2FU1ddsgvNceDL2C
tvC6P01Iy6ElRU+VLEKixBcCgYEAtaScDJBRB1X0nBXAELZlyLOpNhOL/FkorAdD
yhs9IhmsrYUa83rzofUxgREzuy/PLr5PB6YFByDrAJw8AdYPP8QtBohhrMJH7LjG
Yt1vGsRaNwrLw+Gsm2VrxlOMFbAFdvHoxgBzznfTh3ofut12vrR3YMrFJMl9gv6M
4rYtNfECgYEA251LnWaV7BsVwI30QWVhtwmlDReVICCFXI99X78OcGFxWCZJt+80
vDurIk1WdV47hqVOx9r0TAMZTmiJ7fJaj5K/CwwifxdXByAUArwmBXCD90A1ZzDu
crpWnlVGUkszKjxfgoB7JoiZOc3kqiTeJ5UP4xFUylbDFrXlhSZboV8CgYAxuEwq
uDolyuZ47w8yw+qahGsV7UXNHk6ewCJTKR+TvPliSeP1r7sOowIY9S921oBcqCUT
z+Lib6VD9oAKdKCZ8MXuWth5pHhxmKZdG4W1Cvgyxta92IEZzCozEF1w9kyYoWD5
CdipNG2HUOtsiABf9SAUM4zBJBIiEDFaQUmg0QKBgQDcSlh+YDVQip5aIwivhVXs
J+08ZQzMSvCJj7FkzMZmV/bRX9+Y8I5b0P86Pl5nfVnMngfP0p3igmKtdOBQdJRo
eU2e7mYNZBuXIzFAw2OLKbDNtrbwKPCB9o+PEQlwENaKli/tDMAEjqcy0WiqD5Jy
GLYoG8MqluRU5xJe4yE70A==
-----END PRIVATE KEY-----`

type CapturedMessage = {
    rcptTo: string[]
    raw: string
}

let app: FastifyInstance | null = null
let smtpServer: SMTPServer
const capturedMessages: CapturedMessage[] = []

const SMTP_ENV = {
    AP_SMTP_HOST: '127.0.0.1',
    AP_SMTP_USERNAME: 'testuser',
    AP_SMTP_PASSWORD: 'testpass',
    AP_SMTP_SENDER_EMAIL: 'no-reply@qadam.test',
    AP_SMTP_SENDER_NAME: 'Qadam Flow',
}

beforeAll(async () => {
    app = await setupTestEnvironment()
    smtpServer = new SMTPServer({
        authOptional: true,
        secure: false,
        key: TEST_TLS_KEY,
        cert: TEST_TLS_CERT,
        onAuth(auth, _session, callback) {
            callback(null, { user: auth.username })
        },
        onData(stream, session, callback) {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
                capturedMessages.push({
                    rcptTo: session.envelope.rcptTo.map((r) => r.address),
                    raw: Buffer.concat(chunks).toString('utf-8'),
                })
                callback()
            })
        },
    })
    await new Promise<void>((resolve) => smtpServer.listen(0, '127.0.0.1', () => resolve()))
    const smtpPort = (smtpServer.server.address() as AddressInfo).port
    Object.assign(process.env, SMTP_ENV)
    process.env.AP_SMTP_PORT = String(smtpPort)
})

afterAll(async () => {
    for (const key of [...Object.keys(SMTP_ENV), 'AP_SMTP_PORT']) {
        delete process.env[key]
    }
    await new Promise<void>((resolve) => smtpServer.close(() => resolve()))
    await teardownTestEnvironment()
})

describe('Invitation email delivery', () => {
    it('sends an invitation email with the accept link when SMTP is configured', async () => {
        capturedMessages.length = 0
        const ctx1 = await createTestContext(app!)

        const inviteeIdentity = createMockUserIdentity({ verified: true })
        await db.save('user_identity', inviteeIdentity)

        const createRes = await ctx1.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        const inviteRes = await ctx1.post('/v1/user-invitations', {
            email: inviteeIdentity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        const invitation = inviteRes.json<UserInvitationWithLink>()
        const invitationToken = new URL(invitation.link!).searchParams.get('token')!

        expect(capturedMessages).toHaveLength(1)
        const message = capturedMessages[0]
        expect(message.rcptTo).toContain(inviteeIdentity.email)
        const body = decodeQuotedPrintable(message.raw)
        expect(body).toContain(invitationToken)
    })
})

function decodeQuotedPrintable(s: string): string {
    return s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
}
