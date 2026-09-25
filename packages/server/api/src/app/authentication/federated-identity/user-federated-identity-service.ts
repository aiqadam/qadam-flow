import { apId, FederatedIdentityProvider, PlatformId, UserFederatedIdentity, UserId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { UserFederatedIdentityEntity } from './user-federated-identity-entity'

const userFederatedIdentityRepo = repoFactory(UserFederatedIdentityEntity)

export const userFederatedIdentityService = (_log: FastifyBaseLogger) => ({
    async findBySubject({ platformId, provider, subject }: FindBySubjectParams): Promise<UserFederatedIdentity | null> {
        return userFederatedIdentityRepo().findOneBy({ platformId, provider, subject })
    },
    async create({ platformId, userId, provider, subject }: CreateParams): Promise<UserFederatedIdentity> {
        const newIdentity: UserFederatedIdentity = {
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            platformId,
            userId,
            provider,
            subject,
        }
        return userFederatedIdentityRepo().save(newIdentity)
    },
})

type FindBySubjectParams = {
    platformId: PlatformId
    provider: FederatedIdentityProvider
    subject: string
}

type CreateParams = {
    platformId: PlatformId
    userId: UserId
    provider: FederatedIdentityProvider
    subject: string
}
