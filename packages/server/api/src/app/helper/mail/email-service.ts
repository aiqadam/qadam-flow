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
