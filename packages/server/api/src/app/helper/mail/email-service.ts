import { OtpType, UserIdentity } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { domainHelper } from '../domain-helper'
import { emailSender } from './email-sender/email-sender'

export const emailService = (log: FastifyBaseLogger) => ({
    async sendInvitation({ email, platformId, projectName, invitationLink }: SendInvitationArgs): Promise<void> {
        log.info({ email, platformId, projectName }, '[emailService#sendInvitation] sending invitation email')
        await emailSender(log).send({
            emails: [email],
            platformId,
            templateData: {
                name: 'invitation-email',
                vars: {
                    setupLink: invitationLink,
                    projectName,
                },
            },
        })
    },

    async sendProjectMemberAdded({ email, platformId, projectId, projectName, role }: SendProjectMemberAddedArgs): Promise<void> {
        log.info({ email, platformId, projectId, projectName, role }, '[emailService#sendProjectMemberAdded] sending project member added email')
        const redirectPath = projectId ? `/projects/${projectId}/flows` : '/flows'
        const loginLink = await domainHelper.getPublicUrl({
            path: `sign-in?from=${encodeURIComponent(redirectPath)}`,
        })
        await emailSender(log).send({
            emails: [email],
            platformId,
            templateData: {
                name: 'project-member-added',
                vars: {
                    projectName,
                    role,
                    loginLink,
                },
            },
        })
    },

    async sendOtp({ platformId, userIdentity, otp, type }: SendOtpArgs): Promise<void> {
        if (userIdentity.verified && type === OtpType.EMAIL_VERIFICATION) {
            return
        }

        log.info({ identityId: userIdentity.id, platformId, type }, '[emailService#sendOtp] sending otp email')

        const frontendPath: Record<OtpType, 'verify-email' | 'reset-password'> = {
            [OtpType.EMAIL_VERIFICATION]: 'verify-email',
            [OtpType.PASSWORD_RESET]: 'reset-password',
        }
        const templateName = frontendPath[type]
        const setupLink = await domainHelper.getPublicUrl({
            path: `${templateName}?otpcode=${otp}&identityId=${userIdentity.id}`,
        })

        await emailSender(log).send({
            emails: [userIdentity.email],
            platformId: platformId ?? undefined,
            templateData: {
                name: templateName,
                vars: {
                    setupLink,
                },
            },
        })
    },
})

type SendInvitationArgs = {
    email: string
    platformId: string | undefined
    projectName: string
    invitationLink: string
}

type SendProjectMemberAddedArgs = {
    email: string
    platformId: string | undefined
    projectId: string | undefined
    projectName: string
    role: string
}

type SendOtpArgs = {
    type: OtpType
    platformId: string | null
    otp: string
    userIdentity: UserIdentity
}
