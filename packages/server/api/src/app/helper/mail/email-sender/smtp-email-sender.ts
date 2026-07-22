import { readFile } from 'node:fs/promises'
import { ApEnvironment, ErrorCode, isNil, PlatformWithoutFederatedAuth, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import Mustache from 'mustache'
import nodemailer, { Transporter } from 'nodemailer'
import tinycolor from 'tinycolor2'
import { defaultTheme } from '../../../flags/theme'
import { platformService } from '../../../platform/platform.service'
import { system } from '../../system/system'
import { AppSystemProp } from '../../system/system-props'
import { EmailSender, EmailTemplateData } from './email-sender'

const LIGHT_TINT_PERCENT = 8

export const smtpEmailSender = (log: FastifyBaseLogger): SMTPEmailSender => {
    return {
        async validateOrThrow() {
            if (system.getOrThrow(AppSystemProp.ENVIRONMENT) !== ApEnvironment.PRODUCTION) {
                return
            }
            const smtpClient = initSmtpClient()
            try {
                await smtpClient.verify()
            }
            catch (e) {
                throw new QadamFlowError({
                    code: ErrorCode.INVALID_SMTP_CREDENTIALS,
                    params: { message: String(e) },
                })
            }
        },
        async send({ emails, platformId, templateData }) {
            const emailSubject = getEmailSubject({ templateName: templateData.name, vars: templateData.vars })

            if (!isSmtpConfigured()) {
                log.error({ emailSubject }, '[smtpEmailSender#send] SMTP is not configured')
                return
            }

            try {
                const platform = await getPlatform({ platformId, log })
                const senderName = system.get(AppSystemProp.SMTP_SENDER_NAME)
                const senderEmail = system.get(AppSystemProp.SMTP_SENDER_EMAIL)

                const emailBody = await renderEmailBody({
                    platform,
                    templateData,
                })

                const smtpClient = initSmtpClient()
                log.info({
                    emails,
                    platformId,
                    template: templateData.name,
                }, '[smtpEmailSender#send] sending email')
                await smtpClient.sendMail({
                    from: `${senderName} <${senderEmail}>`,
                    to: emails.join(','),
                    subject: emailSubject,
                    html: emailBody,
                })
            }
            catch (e) {
                log.error({
                    error: e,
                    emails,
                    platformId,
                    title: templateData.name,
                }, '[smtpEmailSender#send] error sending email')
                throw e
            }
        },

        isSmtpConfigured,
    }
}

export const isSmtpConfigured = (): boolean => {
    return [AppSystemProp.SMTP_HOST, AppSystemProp.SMTP_PORT, AppSystemProp.SMTP_USERNAME, AppSystemProp.SMTP_PASSWORD]
        .every(prop => !isNil(system.get(prop)))
}

const getPlatform = async ({ platformId, log }: GetPlatformArgs): Promise<PlatformWithoutFederatedAuth | null> => {
    return platformId ? platformService(log).getOne(platformId) : null
}

const renderEmailBody = async ({ platform, templateData }: RenderEmailBodyArgs): Promise<string> => {
    const templatePath = `packages/server/api/src/assets/emails/${templateData.name}.html`
    const footerPath = 'packages/server/api/src/assets/emails/footer.html'
    const template = await readFile(templatePath, 'utf-8')
    const footer = await readFile(footerPath, 'utf-8')
    const primaryColor = platform?.primaryColor ?? defaultTheme.colors.primary.default
    const primaryColorLight = hexToLightTint({ hex: primaryColor })
    const fullLogoUrl = platform?.fullLogoUrl ?? defaultTheme.logos.fullLogoUrl
    const platformName = platform?.name ?? defaultTheme.websiteName

    return Mustache.render(template, {
        ...templateData.vars,
        primaryColor,
        primaryColorLight,
        fullLogoUrl,
        platformName,
    },
    {
        footer,
    },
    )
}

const initSmtpClient = (): Transporter => {
    const smtpPort = Number.parseInt(system.getOrThrow(AppSystemProp.SMTP_PORT))
    return nodemailer.createTransport({
        host: system.getOrThrow(AppSystemProp.SMTP_HOST),
        port: smtpPort,
        secure: smtpPort === 465,
        auth: {
            user: system.getOrThrow(AppSystemProp.SMTP_USERNAME),
            pass: system.getOrThrow(AppSystemProp.SMTP_PASSWORD),
        },
    })
}

const getEmailSubject = ({ templateName, vars }: GetEmailSubjectArgs): string => {
    const templateToSubject: Record<EmailTemplateData['name'], string> = {
        'invitation-email': `You have been invited to "${vars.projectName}" project ✉️`,
        'project-member-added': `Welcome to ${vars.projectName} 🎉`,
        'verify-email': 'Verify your email address ✅',
        'reset-password': 'Reset your password 🔑',
        'issue-created': `[${vars.projectName}] Flow has an issue "${vars.flowName}" ⚠️`,
    }

    return templateToSubject[templateName]
}

const hexToLightTint = ({ hex }: { hex: string }): string => {
    const color = tinycolor(hex)
    if (!color.isValid()) {
        return '#ffffff'
    }
    return tinycolor.mix('#ffffff', hex, LIGHT_TINT_PERCENT).toHexString()
}

export type SMTPEmailSender = EmailSender & {
    validateOrThrow(): Promise<void>
    isSmtpConfigured(): boolean
}

type RenderEmailBodyArgs = {
    platform: PlatformWithoutFederatedAuth | null
    templateData: EmailTemplateData
}

type GetPlatformArgs = {
    platformId: string | undefined
    log: FastifyBaseLogger
}

type GetEmailSubjectArgs = {
    templateName: EmailTemplateData['name']
    vars: Record<string, string>
}
