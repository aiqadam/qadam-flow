import { FastifyBaseLogger } from 'fastify'
import { logEmailSender } from './log-email-sender'
import { isSmtpConfigured, smtpEmailSender } from './smtp-email-sender'

export const emailSender = (log: FastifyBaseLogger): EmailSender => {
    if (isSmtpConfigured()) {
        return smtpEmailSender(log)
    }

    return logEmailSender(log)
}

export type EmailSender = {
    send: (args: SendArgs) => Promise<void>
}

type BaseEmailTemplateData<Name extends string, Vars extends Record<string, string>> = {
    name: Name
    vars: Vars
}

type InvitationEmailTemplateData = BaseEmailTemplateData<'invitation-email', {
    projectName: string
    setupLink: string
}>

type ProjectMemberAddedEmailTemplateData = BaseEmailTemplateData<'project-member-added', {
    projectName: string
    role: string
    loginLink: string
}>

type ResetPasswordEmailTemplateData = BaseEmailTemplateData<'reset-password', {
    setupLink: string
}>

type VerifyEmailTemplateData = BaseEmailTemplateData<'verify-email', {
    setupLink: string
}>

type IssueCreatedTemplateData = BaseEmailTemplateData<'issue-created', {
    runUrl: string
    projectName: string
    flowName: string
    createdAt: string
    failedStepDisplayName: string
    failedStepNumber: string
    failedStepMessage: string
}>

export type EmailTemplateData =
  | InvitationEmailTemplateData
  | ProjectMemberAddedEmailTemplateData
  | ResetPasswordEmailTemplateData
  | VerifyEmailTemplateData
  | IssueCreatedTemplateData

type SendArgs = {
    emails: string[]
    platformId: string | undefined
    templateData: EmailTemplateData
}
