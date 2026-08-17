import { readFile } from 'node:fs/promises'
import { ApEnvironment, ErrorCode, isNil, PlatformWithoutFederatedAuth, QadamFlowError, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import Mustache from 'mustache'
import nodemailer, { Transporter } from 'nodemailer'
import tinycolor from 'tinycolor2'
import { defaultTheme } from '../../../flags/theme'
import { platformService } from '../../../platform/platform.service'
import { domainHelper } from '../../domain-helper'
import { system } from '../../system/system'
import { AppSystemProp } from '../../system/system-props'
import { EmailSender, EmailTemplateData } from './email-sender'

const LIGHT_TINT_PERCENT = 8

const ALLOWED_TEMPLATE_NAMES = new Set<EmailTemplateData['name']>([
    'invitation-email',
    'project-member-added',
    'verify-email',
    'reset-password',
    'issue-created',
])

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
                    log,
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

const renderEmailBody = async ({ platform, templateData, log }: RenderEmailBodyArgs): Promise<string> => {
    if (!ALLOWED_TEMPLATE_NAMES.has(templateData.name)) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: `Unknown email template: ${templateData.name}` },
        })
    }
    const templatePath = `packages/server/api/src/assets/emails/${templateData.name}.html`
    const footerPath = 'packages/server/api/src/assets/emails/footer.html'
    const template = await readFile(templatePath, 'utf-8')
    const footer = await readFile(footerPath, 'utf-8')
    const primaryColor = platform?.primaryColor ?? defaultTheme.colors.primary.default
    const primaryColorLight = hexToLightTint({ hex: primaryColor })
    const fullLogoUrl = await toAbsoluteAssetUrl(platform?.fullLogoUrl ?? defaultTheme.logos.fullLogoUrl, log)
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

/**
 * An email has no base URL, so a root-relative asset path can never resolve in a mail client.
 * `defaultTheme.logos.fullLogoUrl` is `/logo.svg` and the platform row stores the same value on a
 * stock install, so every template — all seven carry `{{fullLogoUrl}}` — shipped a broken image.
 * It is invisible from inside the product, where the identical path resolves against the app's own
 * origin.
 *
 * Resolution goes through `domainHelper.getPublicUrl`, the same helper that builds the invitation
 * and OTP links in these very emails, so the logo cannot end up on a different host from the button
 * next to it.
 *
 * A value that already carries a scheme is left untouched: that covers an operator's CDN URL and a
 * `data:` URI, which prefixing would corrupt. `new URL(value)` succeeding is precisely the
 * "has a scheme" test. A protocol-relative `//cdn/logo.png` throws there and is therefore treated
 * as relative — rare enough to accept, and it degrades to a wrong URL rather than a broken send.
 *
 * It degrades instead of throwing, and that is deliberate. `domainHelper.getPublicUrl` is
 * `getOrThrow(FRONTEND_URL)`; today that prop is a hard dependency of the OTP path only, so an
 * install missing it still delivers invitations — with a broken logo. Letting the throw through
 * here would turn a cosmetic defect into undelivered invitations, which is strictly worse. The
 * caller gets the original relative value back, i.e. exactly the behaviour that shipped before.
 */
export async function toAbsoluteAssetUrl(assetUrl: string, log: FastifyBaseLogger): Promise<string> {
    const { data: parsed } = tryCatchSync(() => new URL(assetUrl))
    if (!isNil(parsed)) {
        return assetUrl
    }
    const { data: absolute, error } = await tryCatch(() => domainHelper.getPublicUrl({ path: assetUrl }))
    if (isNil(absolute)) {
        log.warn({ assetUrl, error }, '[smtpEmailSender] could not absolutise the email logo URL; sending it as-is, so it will not render in a mail client')
        return assetUrl
    }
    return absolute
}

const initSmtpClient = (): Transporter => {
    const smtpPort = Number.parseInt(system.getOrThrow(AppSystemProp.SMTP_PORT))
    const useSSL = system.getBoolean(AppSystemProp.SMTP_USE_SSL) ?? (smtpPort === 465)
    return nodemailer.createTransport({
        host: system.getOrThrow(AppSystemProp.SMTP_HOST),
        port: smtpPort,
        secure: useSSL,
        requireTLS: !useSSL,
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
    log: FastifyBaseLogger
}

type GetPlatformArgs = {
    platformId: string | undefined
    log: FastifyBaseLogger
}

type GetEmailSubjectArgs = {
    templateName: EmailTemplateData['name']
    vars: Record<string, string>
}
