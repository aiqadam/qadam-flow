import { AddressInfo } from 'node:net'
import { SMTPServer } from 'smtp-server'
import { emailSender } from '../../../../src/app/helper/mail/email-sender/email-sender'
import { isSmtpConfigured, smtpEmailSender } from '../../../../src/app/helper/mail/email-sender/smtp-email-sender'
import { system } from '../../../../src/app/helper/system/system'

type CapturedMessage = {
    rcptTo: string[]
    mailFrom: string
    raw: string
}

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
        disabledCommands: ['STARTTLS'],
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
