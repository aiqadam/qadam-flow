import { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { defaultTheme } from '../../../../src/app/flags/theme'
import { emailSender } from '../../../../src/app/helper/mail/email-sender/email-sender'
import { isSmtpConfigured, smtpEmailSender, toAbsoluteAssetUrl } from '../../../../src/app/helper/mail/email-sender/smtp-email-sender'
import { system } from '../../../../src/app/helper/system/system'

// The sender enforces STARTTLS on non-SSL ports; accept the throwaway
// self-signed cert of the in-process test server.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

// Throwaway self-signed cert for the localhost test SMTP server (STARTTLS).
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
    mailFrom: string
    raw: string
}

// Mustache escapes {{fullLogoUrl}}, so a URL arrives as `http:&#x2F;&#x2F;host&#x2F;logo.png`.
// That is valid in a src and renders fine — it only has to be undone to compare against the plain
// URL an assertion is naturally written in terms of.
const decodeHtmlEntities = (html: string): string =>
    html.replace(/&(?:amp|lt|gt|quot|#39|#x60|#x3D|#x2F);/g, (entity) => MUSTACHE_ENTITIES[entity])

// nodemailer sends the HTML part quoted-printable, which does two things a substring assertion has
// to undo: it soft-wraps long lines with a trailing '=' (a URL is exactly the kind of token that
// gets split), and it escapes '=' itself as '=3D' — so an un-decoded body contains `src=3D"..."`
// and never `src="..."`. Soft breaks first, then the hex escapes; the other order would mangle a
// line that happens to wrap immediately after an escape.
const decodeQuotedPrintable = (raw: string): string =>
    raw
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

const capturedMessages: CapturedMessage[] = []
let smtpServer: SMTPServer
let smtpPort: number

const SMTP_ENV = {
    AP_SMTP_HOST: '127.0.0.1',
    AP_SMTP_USERNAME: 'testuser',
    AP_SMTP_PASSWORD: 'testpass',
    AP_SMTP_SENDER_EMAIL: 'no-reply@qadam.test',
    AP_SMTP_SENDER_NAME: 'Qadam Flow',
}

const setSmtpEnv = (): void => {
    Object.assign(process.env, SMTP_ENV)
    process.env.AP_SMTP_PORT = String(smtpPort)
}

const clearSmtpEnv = (): void => {
    for (const key of [...Object.keys(SMTP_ENV), 'AP_SMTP_PORT']) {
        delete process.env[key]
    }
}

beforeAll(async () => {
    smtpServer = new SMTPServer({
        authOptional: true,
        secure: false,
        key: TEST_TLS_KEY,
        cert: TEST_TLS_CERT,
        onAuth(auth, session, callback) {
            callback(null, { user: auth.username })
        },
        onData(stream, session, callback) {
            const chunks: Buffer[] = []
            stream.on('data', (chunk: Buffer) => chunks.push(chunk))
            stream.on('end', () => {
                capturedMessages.push({
                    rcptTo: session.envelope.rcptTo.map((r) => r.address),
                    mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
                    raw: Buffer.concat(chunks).toString('utf-8'),
                })
                callback()
            })
        },
    })

    await new Promise<void>((resolve) => {
        smtpServer.listen(0, '127.0.0.1', () => resolve())
    })
    smtpPort = (smtpServer.server.address() as AddressInfo).port
})

afterAll(async () => {
    clearSmtpEnv()
    await new Promise<void>((resolve) => smtpServer.close(() => resolve()))
})

beforeEach(() => {
    capturedMessages.length = 0
    setSmtpEnv()
})

describe('smtpEmailSender', () => {
    describe('isSmtpConfigured', () => {
        it('returns true when all required SMTP props are set', () => {
            expect(isSmtpConfigured()).toBe(true)
        })

        it('returns false when a required SMTP prop is missing', () => {
            delete process.env.AP_SMTP_HOST
            expect(isSmtpConfigured()).toBe(false)
        })
    })

    describe('send', () => {
        it('delivers a rendered invitation email over SMTP', async () => {
            await smtpEmailSender(system.globalLogger()).send({
                emails: ['invitee@qadam.test'],
                platformId: undefined,
                templateData: {
                    name: 'invitation-email',
                    vars: {
                        projectName: 'QadamTestProject',
                        setupLink: 'https://flow.test/invitation?token=inviteToken123',
                    },
                },
            })

            expect(capturedMessages).toHaveLength(1)
            const message = capturedMessages[0]
            expect(message.rcptTo).toContain('invitee@qadam.test')
            expect(message.mailFrom).toBe('no-reply@qadam.test')
            expect(message.raw).toContain('QadamTestProject')
            expect(message.raw).toContain('inviteToken123')
        })

        // An email carries no base URL, so the root-relative path `defaultTheme` ships — and that a
        // stock platform row stores — renders as a broken image in every mail client. It looked
        // fine from inside the product, where the same path resolves against the app's own origin,
        // which is why it survived to a release.
        it('renders the logo as an absolute URL so it resolves in a mail client', async () => {
            await smtpEmailSender(system.globalLogger()).send({
                emails: ['invitee@qadam.test'],
                platformId: undefined,
                templateData: {
                    name: 'invitation-email',
                    vars: {
                        projectName: 'QadamTestProject',
                        setupLink: 'https://flow.test/invitation?token=inviteToken123',
                    },
                },
            })

            const html = decodeHtmlEntities(decodeQuotedPrintable(capturedMessages[0].raw))
            const logoPath = defaultTheme.logos.fullLogoUrl
            // Read off the theme rather than hardcoded, so changing the default asset does not
            // silently turn this into an assertion about a file nobody ships any more.
            expect(html).toContain(`src="${process.env.AP_FRONTEND_URL}${logoPath}"`)
            // The exact string above, not merely "contains http": the relative form is a substring
            // of the absolute one, so only pinning the whole `src` catches a regression to it.
            expect(html).not.toContain(`src="${logoPath}"`)
        })

        // Not style: Gmail strips SVG from an email body outright and Outlook's Word engine cannot
        // render it, so a vector default would be invisible to most recipients even once the URL
        // is absolute. The same reasoning is why og:image points at a PNG.
        it('ships a raster default logo, because email clients do not render SVG', () => {
            expect(defaultTheme.logos.fullLogoUrl).toMatch(/\.(png|jpe?g|gif)$/)
        })

        it.each([
            ['an operator CDN URL', 'https://cdn.example/brand/logo.png'],
            ['a data URI', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
            ['a plain http URL', 'http://assets.internal/logo.png'],
        ])('leaves %s untouched — prefixing it would corrupt it', async (_label, absolute) => {
            expect(await toAbsoluteAssetUrl(absolute, system.globalLogger())).toBe(absolute)
        })

        it('falls back to the original value rather than failing the send when the frontend URL is unset', async () => {
            // `domainHelper.getPublicUrl` is `getOrThrow(FRONTEND_URL)`. An install missing that
            // prop currently still delivers invitations, with a broken logo; turning that into an
            // undelivered invitation would be a worse trade than the defect being fixed.
            const frontendUrl = process.env.AP_FRONTEND_URL
            delete process.env.AP_FRONTEND_URL
            try {
                expect(await toAbsoluteAssetUrl('/logo.svg', system.globalLogger())).toBe('/logo.svg')
            }
            finally {
                process.env.AP_FRONTEND_URL = frontendUrl
            }
        })

        it('is a no-op (no throw, no delivery) when SMTP is not configured', async () => {
            delete process.env.AP_SMTP_HOST

            await expect(
                smtpEmailSender(system.globalLogger()).send({
                    emails: ['invitee@qadam.test'],
                    platformId: undefined,
                    templateData: {
                        name: 'invitation-email',
                        vars: {
                            projectName: 'QadamTestProject',
                            setupLink: 'https://flow.test/invitation?token=inviteToken123',
                        },
                    },
                }),
            ).resolves.toBeUndefined()

            expect(capturedMessages).toHaveLength(0)
        })
    })

    describe('emailSender routing', () => {
        it('delivers over SMTP when SMTP is configured (independent of ENVIRONMENT)', async () => {
            await emailSender(system.globalLogger()).send({
                emails: ['routed@qadam.test'],
                platformId: undefined,
                templateData: {
                    name: 'invitation-email',
                    vars: {
                        projectName: 'RoutedProject',
                        setupLink: 'https://flow.test/invitation?token=routedToken',
                    },
                },
            })

            expect(capturedMessages).toHaveLength(1)
            expect(capturedMessages[0].rcptTo).toContain('routed@qadam.test')
        })

        it('does not deliver (falls back to log sender) when SMTP is not configured', async () => {
            delete process.env.AP_SMTP_HOST

            await emailSender(system.globalLogger()).send({
                emails: ['routed@qadam.test'],
                platformId: undefined,
                templateData: {
                    name: 'invitation-email',
                    vars: {
                        projectName: 'RoutedProject',
                        setupLink: 'https://flow.test/invitation?token=routedToken',
                    },
                },
            })

            expect(capturedMessages).toHaveLength(0)
        })
    })
})

const MUSTACHE_ENTITIES: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': '\'',
    '&#x60;': '`',
    '&#x3D;': '=',
    '&#x2F;': '/',
}
