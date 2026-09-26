import { apId, FederatedIdentityProvider, PlatformId, UserFederatedIdentity, UserId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { EntityManager, In } from 'typeorm'
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
            lastReconciledAt: null,
        }
        return userFederatedIdentityRepo(entityManager).save(newIdentity)
    },
    // Reconcile's own population: every user this platform's directory has ever linked, regardless
    // of current `user.status` — reconcile itself decides deactivate/reactivate/leave. Ordered
    // oldest-reconciled-first (`NULLS FIRST` puts a user reconcile has never touched ahead of one it
    // touched a moment ago) so the per-platform time budget's cutoff falls on a different slice of
    // users each tick, rather than always starving the same tail of the list; `id` is a tie-break for
    // rows sharing the same `lastReconciledAt` (in particular the initial "all NULL" state), so the
    // ordering — and therefore which users a given tick actually reaches — is deterministic rather
    // than left to whatever order the database happens to return ties in.
    async listByPlatformAndProvider({ platformId, provider, entityManager }: ListByPlatformAndProviderParams): Promise<UserFederatedIdentity[]> {
        return userFederatedIdentityRepo(entityManager)
            .createQueryBuilder('user_federated_identity')
            .where({ platformId, provider })
            .orderBy('user_federated_identity.lastReconciledAt', 'ASC', 'NULLS FIRST')
            .addOrderBy('user_federated_identity.id', 'ASC')
            .getMany()
    },
    // Only ever called by reconcile — never by sign-in, and never by an admin action — so this
    // field stays a reliable record of "the directory itself did this", not "someone deactivated
    // this user for any reason". Scoped by `platformId` too (not just the row's own `id`) for
    // multi-tenant safety, even though `id` alone is already unique.
    async setDirectoryDisabledAt({ id, platformId, directoryDisabledAt, entityManager }: SetDirectoryDisabledAtParams): Promise<void> {
        await userFederatedIdentityRepo(entityManager).update({ id, platformId }, { directoryDisabledAt })
    },
    // Atomic, not read-then-write: the `WHERE "directoryDisabledAt" IS NOT NULL` on the update
    // itself is the race-safety, not a preceding read — an admin's own deactivation clears this
    // exact marker (`clearDirectoryDisabledAtForUser`), and that write can land in the moment
    // between reconcile's earlier snapshot of this row and its own write-back phase running.
    // Returns whether the marker was actually still set (and so actually cleared by this call) —
    // `false` means someone else cleared it first, which the caller must treat as "do not
    // reactivate this user", not merely "nothing to clean up".
    async clearDirectoryDisabledAtIfSet({ id, platformId, entityManager }: ClearDirectoryDisabledAtIfSetParams): Promise<boolean> {
        const result = await userFederatedIdentityRepo(entityManager)
            .createQueryBuilder()
            .update()
            .set({ directoryDisabledAt: null })
            .where('id = :id', { id })
            .andWhere('"platformId" = :platformId', { platformId })
            .andWhere('"directoryDisabledAt" IS NOT NULL')
            .execute()
        return (result.affected ?? 0) > 0
    },
    // Stamped once per identity, right after reconcile actually finishes processing it within
    // budget (never for an identity the time budget left untouched this tick) — the single write
    // `listByPlatformAndProvider`'s ordering depends on to rotate the starting point.
    async markReconciled({ ids, platformId, at, entityManager }: MarkReconciledParams): Promise<void> {
        if (ids.length === 0) {
            return
        }
        await userFederatedIdentityRepo(entityManager).update({ id: In(ids), platformId }, { lastReconciledAt: at })
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
    platformId: PlatformId
    directoryDisabledAt: string | null
    entityManager?: EntityManager
}

type ClearDirectoryDisabledAtIfSetParams = {
    id: string
    platformId: PlatformId
    entityManager?: EntityManager
}

type MarkReconciledParams = {
    ids: string[]
    platformId: PlatformId
    at: string
    entityManager?: EntityManager
}

type ClearDirectoryDisabledAtForUserParams = {
    userId: UserId
    platformId: PlatformId
    entityManager?: EntityManager
}
