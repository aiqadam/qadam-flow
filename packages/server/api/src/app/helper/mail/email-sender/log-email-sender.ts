import { FastifyBaseLogger } from 'fastify'
import { EmailSender } from './email-sender'

export const logEmailSender = (log: FastifyBaseLogger): EmailSender => {
    return {
        async send({ emails, platformId, templateData }) {
            log.debug({
                name: 'LogEmailSender#send',
                emails,
                platformId,
                templateData,
            })
        },
    }
}
