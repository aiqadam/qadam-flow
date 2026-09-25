import { apId, FederatedIdentityProvider, PlatformId, UserFederatedIdentity, UserId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import { UserFederatedIdentityEntity } from './user-federated-identity-entity'

const userFederatedIdentityRepo = repoFactory(UserFederatedIdentityEntity)

export const userFederatedIdentityService = (_log: FastifyBaseLogger) => ({
    async findBySubject({ platformId, provider, subject, entityManager }: FindBySubjectParams): Promise<UserFederatedIdentity | null> {
        return userFederatedIdentityRepo(entityManager).findOneBy({ platformId, provider, subject })
    },
    // Reads the (platformId, userId, provider) unique row directly — the one a federated identity
    // can have at most one of per platform — so the caller can tell "never linked on this
    // platform" (create) apart from "linked, but the directory's subject moved under the same
    // email" (an explicit refusal; see `ldap-authn-service.ts`) instead of conflating both into a
    // duplicate-key error from `create`.
    async findByUser({ platformId, userId, provider, entityManager }: FindByUserParams): Promise<UserFederatedIdentity | null> {
        return userFederatedIdentityRepo(entityManager).findOneBy({ platformId, userId, provider })
    },
    async create({ platformId, userId, provider, subject, entityManager }: CreateParams): Promise<UserFederatedIdentity> {
        const newIdentity: UserFederatedIdentity = {
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            platformId,
            userId,
            provider,
            subject,
        }
        return userFederatedIdentityRepo(entityManager).save(newIdentity)
    },
})

type FindBySubjectParams = {
    platformId: PlatformId
    provider: FederatedIdentityProvider
    subject: string
    entityManager?: EntityManager
}

type FindByUserParams = {
    platformId: PlatformId
    userId: UserId
    provider: FederatedIdentityProvider
    entityManager?: EntityManager
}

type CreateParams = {
    platformId: PlatformId
    userId: UserId
    provider: FederatedIdentityProvider
    subject: string
    entityManager?: EntityManager
}
