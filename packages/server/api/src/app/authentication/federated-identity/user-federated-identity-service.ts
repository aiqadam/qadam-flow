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
            directoryDisabledAt: null,
        }
        return userFederatedIdentityRepo(entityManager).save(newIdentity)
    },
    // Reconcile's own population (Phase 2): every user this platform's directory has ever linked,
    // regardless of current `user.status` — reconcile itself decides deactivate/reactivate/leave.
    async listByPlatformAndProvider({ platformId, provider, entityManager }: ListByPlatformAndProviderParams): Promise<UserFederatedIdentity[]> {
        return userFederatedIdentityRepo(entityManager).findBy({ platformId, provider })
    },
    // Only ever called by reconcile — never by sign-in, and never by an admin action — so this
    // field stays a reliable record of "the directory itself did this", not "someone deactivated
    // this user for any reason".
    async setDirectoryDisabledAt({ id, directoryDisabledAt, entityManager }: SetDirectoryDisabledAtParams): Promise<void> {
        await userFederatedIdentityRepo(entityManager).update({ id }, { directoryDisabledAt })
    },
    // Called by `userService.update`'s admin path (app-sec paths A and B): any explicit status
    // write a human makes must erase "the directory did this" provenance, whichever direction it
    // goes, so a later reconcile tick can never treat a since-overridden decision as its own to
    // undo. Scoped to (userId, platformId) — a federated row is already unique per platform, this
    // just avoids assuming there is exactly one.
    async clearDirectoryDisabledAtForUser({ userId, platformId, entityManager }: ClearDirectoryDisabledAtForUserParams): Promise<void> {
        await userFederatedIdentityRepo(entityManager).update({ userId, platformId }, { directoryDisabledAt: null })
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

type ListByPlatformAndProviderParams = {
    platformId: PlatformId
    provider: FederatedIdentityProvider
    entityManager?: EntityManager
}

type SetDirectoryDisabledAtParams = {
    id: string
    directoryDisabledAt: string | null
    entityManager?: EntityManager
}

type ClearDirectoryDisabledAtForUserParams = {
    userId: UserId
    platformId: PlatformId
    entityManager?: EntityManager
}
