import { cryptoUtils } from '@aiqadam/server-utils'
import {
    AuthenticationResponse,
    ErrorCode,
    FederatedIdentityProvider,
    isNil,
    LdapTestStage,
    PlatformId,
    PlatformRole,
    QadamFlowError,
    tryCatch,
    UserIdentity,
    UserIdentityProvider,
    UserStatus,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Entry } from 'ldapts'
import { EntityManager } from 'typeorm'
import { transaction } from '../../core/db/transaction'
import { platformService } from '../../platform/platform.service'
import { userService } from '../../user/user-service'
import { authenticationUtils } from '../authentication-utils'
import { userFederatedIdentityService } from '../federated-identity/user-federated-identity-service'
import { userIdentityService } from '../user-identity/user-identity-service'
import { ldapAttributeUtils } from './ldap-attributes'
import { ldapClient } from './ldap-client'
import { ldapConfigService, ResolvedLdapConfig } from './ldap-config-service'
import { LdapStageError } from './ldap-stage-error'
import { ldapUsernameUtils } from './ldap-username'

// Fixed and directory-independent — built only from the platform's own configured `baseDn`, never
// from the caller-supplied username — so the dummy bind (below) carries no information of its own
// and every dummy attempt for a given platform targets the exact same, guaranteed-nonexistent DN.
const DUMMY_BIND_RDN = 'cn=__qadam_flow_timing_oracle_dummy_bind__'
const DUMMY_BIND_PASSWORD = 'qadam-flow-timing-oracle-defense'

export const ldapAuthnService = (log: FastifyBaseLogger) => ({
    async signIn({ platformId, username, password }: SignInParams): Promise<AuthenticationResponse> {
        // Refused before any lookup, config read, or network call — an empty password sent to an
        // unauthenticated ("simple", RFC 4513 §5.1.2) bind succeeds against most directories and
        // would otherwise let a caller who names a valid username skip authentication entirely.
        // The zod schema (`LdapSignInRequest.password.min(1)`) already refuses this at the HTTP
        // boundary; this repeats the check at the service boundary so the guarantee holds for any
        // future caller of this function directly, not only ones that go through the route.
        if (password.length === 0) {
            throw new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
        }

        const resolved = await ldapConfigService(log).getResolvedForSignIn({ platformId })
        if (isNil(resolved) || !resolved.config.enabled) {
            throw new QadamFlowError({ code: ErrorCode.LDAP_DIRECTORY_UNREACHABLE, params: {} })
        }

        const { entry, subject } = await lookupDirectoryUser({ resolved, username, password, log })
        const email = ldapAttributeUtils.readStringAttribute({ entry, name: resolved.config.attributeMap.email })
        if (isNil(email) || email.length === 0) {
            throw new QadamFlowError({
                code: ErrorCode.LDAP_EMAIL_ATTRIBUTE_MISSING,
                params: { attribute: resolved.config.attributeMap.email },
            })
        }
        const firstName = ldapAttributeUtils.readStringAttribute({ entry, name: resolved.config.attributeMap.firstName }) ?? username
        const lastName = ldapAttributeUtils.readStringAttribute({ entry, name: resolved.config.attributeMap.lastName }) ?? ''

        const user = await resolveUser({ platformId, config: resolved.config, subject, email, firstName, lastName, log })
        if (user.status === UserStatus.INACTIVE) {
            throw new QadamFlowError({ code: ErrorCode.USER_IS_INACTIVE, params: { email } })
        }

        log.info({ platformId, userId: user.id }, 'User signed in via LDAP')
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
            expiresInSeconds: resolved.config.sessionTtlSeconds,
        })
    },
})

// Service bind -> search -> user bind on a brand-new connection -> read attributes -> unbind, all
// against one already-decrypted config. Any failure inside is a `LdapStageError` (from
// `ldapClient`) or, once the subject attribute is checked, a plain misconfiguration signal — both
// are translated to one of the four public sign-in error codes by `mapToSignInError`, never leaked
// as their own stage-specific detail (that detail is what the admin-only `/test` endpoint is for).
async function lookupDirectoryUser({ resolved, username, password, log }: LookupDirectoryUserParams): Promise<{ entry: Entry, subject: string }> {
    const { config, bindPassword, connectionConfig } = resolved
    try {
        // The whole connect -> service bind -> search -> unbind sequence runs inside one
        // connection slot, held for its entire lifetime (M1) — the concurrency cap this slot
        // enforces is otherwise only a bound on simultaneous *connects*, not on how many
        // directory connections are actually open at once.
        const { entry, subject } = await ldapClient.withConnectionSlot(async () => {
            const client = await ldapClient.connect({ config: connectionConfig })
            try {
                await ldapClient.serviceBind({ client, bindDn: config.bindDn, bindPassword, tlsMode: config.tlsMode })
                // Normalised the same way, and for the same reason, the rate-limit bucket key is
                // (`ldapUsernameUtils.normalize`'s own comment) — a directory that folds Unicode
                // variants together (most do, since RFC 4515 says nothing about case- or
                // width-folding) must see the same value the rate limiter counted against.
                const entry = await ldapClient.searchForUser({
                    client,
                    baseDn: config.baseDn,
                    userFilter: config.userFilter,
                    username: ldapUsernameUtils.normalize(username),
                    attributeMap: config.attributeMap,
                    tlsMode: config.tlsMode,
                })
                const subject = ldapAttributeUtils.resolveSubject({ entry, attributeMap: config.attributeMap })
                if (isNil(subject) || subject.length === 0) {
                    log.error({ attribute: config.attributeMap.subject }, '[ldapAuthnService] Subject attribute missing or unreadable on the matched directory entry')
                    throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'The configured subject attribute is missing on the matched entry' })
                }
                return { entry, subject }
            }
            finally {
                await client.unbind().catch(() => undefined)
            }
        })
        await ldapClient.bindAsUser({ config: connectionConfig, userDn: entry.dn, password })
        return { entry, subject }
    }
    catch (error) {
        if (error instanceof LdapStageError && error.stage === LdapTestStage.SEARCH && error.notFound === true) {
            await performDummyBind({ connectionConfig, baseDn: config.baseDn, log })
        }
        throw mapToSignInError(error)
    }
}

// Anti-timing-oracle (app-sec L2): without this, "unknown username" short-circuits after one
// connect+search, while "known username, wrong password" pays for a second connect+bind — a
// measurable latency gap that lets a caller enumerate valid usernames from response timing alone,
// even though both cases return the identical `INVALID_CREDENTIALS` body. Paying the same second
// connect+bind cost here closes that gap. The bind is expected to fail (there is no such DN) and
// its outcome — success or failure — is discarded either way; only the *cost* of attempting it
// matters.
async function performDummyBind({ connectionConfig, baseDn, log }: PerformDummyBindParams): Promise<void> {
    const { error } = await tryCatch(() => ldapClient.bindAsUser({
        config: connectionConfig,
        userDn: `${DUMMY_BIND_RDN},${baseDn}`,
        password: DUMMY_BIND_PASSWORD,
    }))
    if (!isNil(error)) {
        log.debug({ err: error }, '[ldapAuthnService] Dummy timing-oracle bind finished (a failure here is expected and harmless)')
    }
}

function mapToSignInError(error: unknown): QadamFlowError {
    if (!(error instanceof LdapStageError)) {
        return new QadamFlowError({ code: ErrorCode.LDAP_DIRECTORY_UNREACHABLE, params: {} })
    }
    switch (error.stage) {
        case LdapTestStage.ALLOW_LIST:
        case LdapTestStage.CONNECT:
            return new QadamFlowError({ code: ErrorCode.LDAP_DIRECTORY_UNREACHABLE, params: {} })
        case LdapTestStage.SERVICE_BIND:
            return new QadamFlowError({ code: ErrorCode.LDAP_BIND_ACCOUNT_REJECTED, params: {} })
        case LdapTestStage.SEARCH:
        case LdapTestStage.USER_BIND:
        case LdapTestStage.SUCCESS:
        default:
            // Anti-enumeration: an unknown username and a known username with the wrong password
            // both land here, with the same message and status — a caller cannot tell "no such
            // directory entry" apart from "wrong password" from this response alone.
            return new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
    }
}

async function resolveUser({ platformId, config, subject, email, firstName, lastName, log }: ResolveUserParams): Promise<{ id: string, status: UserStatus }> {
    const bySubject = await userFederatedIdentityService(log).findBySubject({ platformId, provider: FederatedIdentityProvider.LDAP, subject })
    if (!isNil(bySubject)) {
        const user = await userService(log).getOrThrow({ id: bySubject.userId })
        return { id: user.id, status: user.status }
    }

    const identity = await userIdentityService(log).getIdentityByEmail(email)
    if (!isNil(identity)) {
        return linkOrAdoptExistingIdentity({ platformId, config, subject, identity, log })
    }

    if (!config.jitProvisioning) {
        throw new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
    }
    // Identity + user + federated row created atomically (one transaction): a crash or error
    // between any two of these steps must never leave, say, an identity with no federated row
    // (which would otherwise be a permanently unreachable account — the email is now "taken" by
    // an identity nothing can sign in as, since local password sign-in also refuses `provider ===
    // LDAP`; see `userIdentityService.verifyIdentityPassword`).
    return transaction((entityManager) => provisionNewUser({ platformId, subject, email, firstName, lastName, log, entityManager }))
}

// Reached only by an *email* match — a subject match above is the common, fast path for a user who
// already has a federated row and never touches this function at all. Reaching here by email means
// establishing (or re-establishing) the platformId/subject association, which is exactly the
// moment a hostile directory admin could try to redirect an existing account, so every path
// through this function is gated by `assertIdentityIsNotPrivilegedElsewhere` first, regardless of
// whether the identity is already LDAP-managed or still local.
async function linkOrAdoptExistingIdentity({ platformId, config, subject, identity, log }: LinkOrAdoptParams): Promise<{ id: string, status: UserStatus }> {
    await assertIdentityIsNotPrivilegedElsewhere({ identity, platformId, log })

    if (identity.provider === UserIdentityProvider.LDAP) {
        // Already migrated to LDAP — this is the recovery path (B3), scoped to *this* platform
        // only: the user row on `platformId` was deleted, or a previous JIT died after creating the
        // identity but before the federated row. It is never a route onto a *different* platform —
        // `assertIdentityIsNotPrivilegedElsewhere`, called just above, already refuses any identity
        // that has a user row on another platform, so this branch is unreachable for a "first
        // sign-in elsewhere" case; it would be a collision, not a recovery. No password scramble
        // here — the identity has no local password to protect in the first place, and re-running
        // `linkToFederatedProvider` would immediately trip its own `updatePassword` guard against
        // `provider === LDAP`.
        return transaction((entityManager) => adoptExistingLdapIdentity({ platformId, subject, identity, log, entityManager }))
    }
    if (!config.linkExistingByEmail) {
        throw new QadamFlowError({ code: ErrorCode.LDAP_ACCOUNT_COLLISION, params: { email: identity.email } })
    }
    return transaction((entityManager) => linkLocalIdentityToLdap({ platformId, subject, identity, log, entityManager }))
}

// B1 (cross-platform takeover) + B2 (owner/admin takeover): an identity that already has a user
// row on some *other* platform, or that holds `platformRole: ADMIN` (which includes the owner —
// `platformService.create` always promotes the owner to ADMIN) on *any* platform, is refused
// unconditionally, with the same `LDAP_ACCOUNT_COLLISION` a plain email collision gets — never
// distinguished, so a caller cannot use the response to learn which case applied. This is the
// owner's break-glass: the owner can never be linked or adopted by any directory, on any platform,
// so their local password sign-in always keeps working.
async function assertIdentityIsNotPrivilegedElsewhere({ identity, platformId, log }: AssertNotPrivilegedParams): Promise<void> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    const existingUsers = await userService(log).getByIdentityId({ identityId: identity.id })
    const isPrivilegedOrOwnerAnywhere = existingUsers.some((user) => user.platformRole === PlatformRole.ADMIN || user.id === platform.ownerId)
    const hasUserOnAnotherPlatform = existingUsers.some((user) => !isNil(user.platformId) && user.platformId !== platformId)
    if (isPrivilegedOrOwnerAnywhere || hasUserOnAnotherPlatform) {
        throw new QadamFlowError({ code: ErrorCode.LDAP_ACCOUNT_COLLISION, params: { email: identity.email } })
    }
}

async function adoptExistingLdapIdentity({ platformId, subject, identity, log, entityManager }: AdoptExistingLdapIdentityParams): Promise<{ id: string, status: UserStatus }> {
    const user = await userService(log).getOrCreateWithProject({ identity, platformId, entityManager })
    const existingFederatedRow = await userFederatedIdentityService(log).findByUser({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, entityManager })
    if (isNil(existingFederatedRow)) {
        await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject, entityManager })
        return { id: user.id, status: user.status }
    }
    if (existingFederatedRow.subject !== subject) {
        // Decision (documented, not a default we fell into): the directory's own identifier for
        // this email changed under an existing, already-linked row on this exact platform — the
        // object could have been deleted and recreated, possibly by a different real person who
        // was later assigned the same address. Silently repointing the row to the new subject
        // would hand that new directory entry the old one's account with no admin involved.
        // Refuse instead; re-linking a rotated subject is a deliberate admin action (P2), not
        // something a sign-in attempt does on its own.
        throw new QadamFlowError({ code: ErrorCode.LDAP_ACCOUNT_COLLISION, params: { email: identity.email } })
    }
    return { id: user.id, status: user.status }
}

async function linkLocalIdentityToLdap({ platformId, subject, identity, log, entityManager }: LinkLocalIdentityParams): Promise<{ id: string, status: UserStatus }> {
    await userIdentityService(log).linkToFederatedProvider({ id: identity.id, provider: UserIdentityProvider.LDAP, entityManager })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId, entityManager })
    await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject, entityManager })
    log.info({ platformId, userId: user.id, identityId: identity.id }, 'Linked existing local account to LDAP by email')
    return { id: user.id, status: user.status }
}

async function provisionNewUser({ platformId, subject, email, firstName, lastName, log, entityManager }: ProvisionNewUserParams): Promise<{ id: string, status: UserStatus }> {
    const identity: UserIdentity = await userIdentityService(log).create({
        email,
        firstName,
        lastName,
        password: await cryptoUtils.generateRandomPassword(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
        entityManager,
    })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId, entityManager })
    await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject, entityManager })
    log.info({ platformId, userId: user.id }, 'JIT-provisioned a new user via LDAP')
    return { id: user.id, status: user.status }
}

type SignInParams = {
    platformId: PlatformId
    username: string
    password: string
}

type LookupDirectoryUserParams = {
    resolved: ResolvedLdapConfig
    username: string
    password: string
    log: FastifyBaseLogger
}

type PerformDummyBindParams = {
    connectionConfig: ResolvedLdapConfig['connectionConfig']
    baseDn: string
    log: FastifyBaseLogger
}

type ResolveUserParams = {
    platformId: PlatformId
    config: ResolvedLdapConfig['config']
    subject: string
    email: string
    firstName: string
    lastName: string
    log: FastifyBaseLogger
}

type LinkOrAdoptParams = {
    platformId: PlatformId
    config: ResolvedLdapConfig['config']
    subject: string
    identity: UserIdentity
    log: FastifyBaseLogger
}

type AssertNotPrivilegedParams = {
    identity: UserIdentity
    platformId: PlatformId
    log: FastifyBaseLogger
}

type AdoptExistingLdapIdentityParams = {
    platformId: PlatformId
    subject: string
    identity: UserIdentity
    log: FastifyBaseLogger
    entityManager: EntityManager
}

type LinkLocalIdentityParams = {
    platformId: PlatformId
    subject: string
    identity: UserIdentity
    log: FastifyBaseLogger
    entityManager: EntityManager
}

type ProvisionNewUserParams = {
    platformId: PlatformId
    subject: string
    email: string
    firstName: string
    lastName: string
    log: FastifyBaseLogger
    entityManager: EntityManager
}
