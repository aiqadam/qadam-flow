import { cryptoUtils } from '@aiqadam/server-utils'
import {
    AuthenticationResponse,
    ErrorCode,
    FederatedIdentityProvider,
    isNil,
    LdapTestStage,
    PlatformId,
    QadamFlowError,
    UserIdentity,
    UserIdentityProvider,
    UserStatus,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Entry } from 'ldapts'
import { userService } from '../../user/user-service'
import { authenticationUtils } from '../authentication-utils'
import { userFederatedIdentityService } from '../federated-identity/user-federated-identity-service'
import { userIdentityService } from '../user-identity/user-identity-service'
import { ldapAttributeUtils } from './ldap-attributes'
import { ldapClient } from './ldap-client'
import { ldapConfigService, ResolvedLdapConfig } from './ldap-config-service'
import { LdapStageError } from './ldap-stage-error'

export const ldapAuthnService = (log: FastifyBaseLogger) => ({
    async signIn({ platformId, username, password }: SignInParams): Promise<AuthenticationResponse> {
        // Refused before any lookup, config read, or network call — an empty password sent to an
        // unauthenticated ("simple", RFC 4513 ยง5.1.2) bind succeeds against most directories and
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
        const client = await ldapClient.withConnectionSlot(() => ldapClient.connect({ config: connectionConfig }))
        try {
            await ldapClient.serviceBind({ client, bindDn: config.bindDn, bindPassword })
            const entry = await ldapClient.searchForUser({
                client,
                baseDn: config.baseDn,
                userFilter: config.userFilter,
                username,
                attributeMap: config.attributeMap,
            })
            const subject = ldapAttributeUtils.resolveSubject({ entry, attributeMap: config.attributeMap })
            if (isNil(subject) || subject.length === 0) {
                log.error({ attribute: config.attributeMap.subject }, '[ldapAuthnService] Subject attribute missing or unreadable on the matched directory entry')
                throw new LdapStageError({ stage: LdapTestStage.SEARCH, message: 'The configured subject attribute is missing on the matched entry' })
            }
            await ldapClient.bindAsUser({ config: connectionConfig, userDn: entry.dn, password })
            return { entry, subject }
        }
        finally {
            await client.unbind().catch(() => undefined)
        }
    }
    catch (error) {
        throw mapToSignInError(error)
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
        return linkOrRefuse({ platformId, config, subject, identity, log })
    }

    if (!config.jitProvisioning) {
        throw new QadamFlowError({ code: ErrorCode.INVALID_CREDENTIALS, params: null })
    }
    return provisionNewUser({ platformId, subject, email, firstName, lastName, log })
}

async function linkOrRefuse({ platformId, config, subject, identity, log }: LinkOrRefuseParams): Promise<{ id: string, status: UserStatus }> {
    if (!config.linkExistingByEmail) {
        throw new QadamFlowError({ code: ErrorCode.LDAP_ACCOUNT_COLLISION, params: { email: identity.email } })
    }
    const existingUsers = await userService(log).getByIdentityId({ identityId: identity.id })
    const distinctPlatformCount = new Set(existingUsers.map((user) => user.platformId).filter((id): id is string => !isNil(id))).size
    if (distinctPlatformCount > 1) {
        throw new QadamFlowError({ code: ErrorCode.LDAP_ACCOUNT_COLLISION, params: { email: identity.email } })
    }

    await userIdentityService(log).linkToFederatedProvider({ id: identity.id, provider: UserIdentityProvider.LDAP })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId })
    await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject })
    log.info({ platformId, userId: user.id, identityId: identity.id }, 'Linked existing local account to LDAP by email')
    return { id: user.id, status: user.status }
}

async function provisionNewUser({ platformId, subject, email, firstName, lastName, log }: ProvisionNewUserParams): Promise<{ id: string, status: UserStatus }> {
    const identity: UserIdentity = await userIdentityService(log).create({
        email,
        firstName,
        lastName,
        password: await cryptoUtils.generateRandomPassword(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId })
    await userFederatedIdentityService(log).create({ platformId, userId: user.id, provider: FederatedIdentityProvider.LDAP, subject })
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

type ResolveUserParams = {
    platformId: PlatformId
    config: ResolvedLdapConfig['config']
    subject: string
    email: string
    firstName: string
    lastName: string
    log: FastifyBaseLogger
}

type LinkOrRefuseParams = {
    platformId: PlatformId
    config: ResolvedLdapConfig['config']
    subject: string
    identity: UserIdentity
    log: FastifyBaseLogger
}

type ProvisionNewUserParams = {
    platformId: PlatformId
    subject: string
    email: string
    firstName: string
    lastName: string
    log: FastifyBaseLogger
}
