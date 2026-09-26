import { FederatedIdentityProvider, isNil, PlatformId, tryCatch, UserFederatedIdentity, UserStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Client, Entry } from 'ldapts'
import { distributedLock } from '../../database/redis-connections'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { userService } from '../../user/user-service'
import { userFederatedIdentityService } from '../federated-identity/user-federated-identity-service'
import { ldapAttributeUtils } from './ldap-attributes'
import { ldapClient } from './ldap-client'
import { ldapConfigService, ResolvedLdapConfig } from './ldap-config-service'
import { ldapGroupMappingService } from './ldap-group-mapping-service'

// A user's directory account is checked against `userAccountControl` bit 2 (`ACCOUNTDISABLE`,
// 0x0002) — the AD-specific signal the design calls out. A configurable "disabled account filter"
// for directories that use a different convention is a documented follow-up, not implemented here.
const AD_ACCOUNTDISABLE_BIT = 0x2

const RECONCILE_LOCK_TIMEOUT_SECONDS = 300

export const ldapReconcileService = (log: FastifyBaseLogger) => ({
    // The system job's own handler (`ldap-reconcile-module.ts`) calls this once per tick. One
    // platform's failure — an outage, a lock timeout, anything `reconcileOnePlatform` doesn't
    // already turn into a same-platform no-op — must never stop the remaining platforms from being
    // reconciled in the same run.
    async reconcileAllPlatforms(): Promise<void> {
        if (system.getBoolean(AppSystemProp.LDAP_RECONCILE_ENABLED) === false) {
            log.debug('[ldapReconcileService] LDAP_RECONCILE_ENABLED is false; skipping this tick')
            return
        }
        const platformIds = await ldapConfigService(log).listEnabledPlatformIds()
        for (const platformId of platformIds) {
            const { error } = await tryCatch(() => distributedLock(log).runExclusive({
                key: `ldap-reconcile:${platformId}`,
                timeoutInSeconds: RECONCILE_LOCK_TIMEOUT_SECONDS,
                fn: () => reconcileOnePlatform({ platformId, log }),
            }))
            if (!isNil(error)) {
                log.error({ err: error, platformId }, '[ldapReconcileService] Reconcile failed for this platform; continuing with the next one')
            }
        }
    },
})

async function reconcileOnePlatform({ platformId, log }: ReconcileOnePlatformParams): Promise<void> {
    const resolved = await ldapConfigService(log).getResolvedForSignIn({ platformId })
    if (isNil(resolved) || !resolved.config.enabled) {
        return
    }

    const linkedIdentities = await userFederatedIdentityService(log).listByPlatformAndProvider({
        platformId,
        provider: FederatedIdentityProvider.LDAP,
    })
    if (linkedIdentities.length === 0) {
        return
    }

    // FAIL-OPEN on outage: a connect or service-bind failure means the directory could not be
    // reached at all for this run — every linked user is left exactly as-is, not deactivated.
    const { data: results, error: outageError } = await tryCatch(() => collectDirectoryState({ resolved, linkedIdentities, log }))
    if (!isNil(outageError) || isNil(results)) {
        log.error({ err: outageError, platformId }, '[ldapReconcileService] Could not reach the directory for this platform; deactivating nobody this run (fail-open)')
        return
    }

    const goneOrDisabled = results.filter((result): result is GoneOrDisabledResult => result.kind === 'gone' || result.kind === 'disabled')
    const present = results.filter((result): result is PresentResult => result.kind === 'present')

    const safetyValvePercent = system.getNumber(AppSystemProp.LDAP_RECONCILE_SAFETY_VALVE_PERCENT) ?? 20
    const maxDeactivations = Math.ceil((linkedIdentities.length * safetyValvePercent) / 100)
    const safetyValveTripped = goneOrDisabled.length > maxDeactivations

    if (safetyValveTripped) {
        log.error({
            platformId,
            wouldDeactivate: goneOrDisabled.length,
            maxDeactivations,
            totalLinkedUsers: linkedIdentities.length,
        }, '[ldapReconcileService] Safety valve tripped — this run would deactivate more than the configured share of LDAP users; deactivating nobody')
    }
    else {
        for (const result of goneOrDisabled) {
            await deactivateUser({ identity: result.identity, log })
        }
    }

    for (const result of present) {
        await reactivateIfDirectoryDisabled({ identity: result.identity, log })
        const { error: mappingError } = await tryCatch(() => ldapGroupMappingService(log).applyMapping({
            platformId,
            userId: result.identity.userId,
            config: resolved.config,
            memberGroupDns: result.memberGroupDns,
        }))
        if (!isNil(mappingError)) {
            log.error({ err: mappingError, platformId, userId: result.identity.userId }, '[ldapReconcileService] Failed to re-apply LDAP group mapping during reconcile')
        }
    }
}

// Everything inside one connection: connect, service bind, then one subject search per linked
// user. A connect/bind failure here propagates straight out to the caller's outage handling —
// deliberately not caught inside this function, since that failure means the *whole* run for this
// platform is an outage, not a per-user problem.
async function collectDirectoryState({ resolved, linkedIdentities, log }: CollectDirectoryStateParams): Promise<PerUserResult[]> {
    return ldapClient.withConnectionSlot(async () => {
        const client = await ldapClient.connect({ config: resolved.connectionConfig })
        try {
            await ldapClient.serviceBind({ client, bindDn: resolved.config.bindDn, bindPassword: resolved.bindPassword, tlsMode: resolved.config.tlsMode })
            const results: PerUserResult[] = []
            for (const identity of linkedIdentities) {
                results.push(await resolveOneIdentity({ client, identity, resolved, log }))
            }
            return results
        }
        finally {
            await client.unbind().catch(() => undefined)
        }
    })
}

// FAIL-CLOSED per account: any error here other than "no such object" (a definitive, successful
// answer of "this entry is gone") leaves that one account untouched for this run — logged, but
// never treated as grounds to deactivate.
async function resolveOneIdentity({ client, identity, resolved, log }: ResolveOneIdentityParams): Promise<PerUserResult> {
    const { data: entry, error } = await tryCatch(() => ldapClient.searchBySubject({
        client,
        baseDn: resolved.config.baseDn,
        attributeMap: resolved.config.attributeMap,
        subject: identity.subject,
        tlsMode: resolved.config.tlsMode,
    }))
    if (!isNil(error)) {
        log.warn({ err: error, platformId: identity.platformId, userId: identity.userId }, '[ldapReconcileService] Could not look up a linked user in the directory this run; leaving them untouched')
        return { identity, kind: 'skipped' }
    }
    if (isNil(entry)) {
        return { identity, kind: 'gone' }
    }
    if (isAccountDisabled(entry)) {
        return { identity, kind: 'disabled' }
    }
    const memberGroupDns = await ldapClient.resolveMemberGroupDns({ client, entry, config: resolved.config, tlsMode: resolved.config.tlsMode })
    return { identity, kind: 'present', memberGroupDns }
}

function isAccountDisabled(entry: Entry): boolean {
    const rawValue = ldapAttributeUtils.readStringAttribute({ entry, name: 'userAccountControl' })
    if (isNil(rawValue)) {
        return false
    }
    const uac = Number(rawValue)
    return Number.isFinite(uac) && (uac & AD_ACCOUNTDISABLE_BIT) !== 0
}

// The owner can never hold an LDAP federated identity in the first place
// (`assertIdentityIsNotPrivilegedElsewhere` in `ldap-authn-service.ts` refuses to ever link or
// adopt one), so `userService.update` refusing to deactivate the owner is defense in depth here,
// not the primary guard — but it is still respected: a rejection just means this one user is
// skipped, not that the whole run aborts.
async function deactivateUser({ identity, log }: DeactivateUserParams): Promise<void> {
    const user = await userService(log).getOrThrow({ id: identity.userId })
    if (user.status === UserStatus.INACTIVE) {
        return
    }
    const { error } = await tryCatch(() => userService(log).update({ id: identity.userId, platformId: identity.platformId, status: UserStatus.INACTIVE }))
    if (!isNil(error)) {
        log.warn({ err: error, userId: identity.userId, platformId: identity.platformId }, '[ldapReconcileService] Could not deactivate a user this run')
        return
    }
    await userFederatedIdentityService(log).setDirectoryDisabledAt({ id: identity.id, directoryDisabledAt: new Date().toISOString() })
}

// Reactivates only a user *this* reconcile job itself deactivated (`directoryDisabledAt` set) —
// never a user an admin deactivated by hand, which never carries this marker and so is never
// touched here.
async function reactivateIfDirectoryDisabled({ identity, log }: ReactivateIfDirectoryDisabledParams): Promise<void> {
    if (isNil(identity.directoryDisabledAt)) {
        return
    }
    const user = await userService(log).getOrThrow({ id: identity.userId })
    if (user.status !== UserStatus.INACTIVE) {
        // Reactivated some other way already (or never actually deactivated) — clear the stale
        // marker so a future disable-then-reconcile cycle is tracked correctly from a clean state.
        await userFederatedIdentityService(log).setDirectoryDisabledAt({ id: identity.id, directoryDisabledAt: null })
        return
    }
    await userService(log).update({ id: identity.userId, platformId: identity.platformId, status: UserStatus.ACTIVE })
    await userFederatedIdentityService(log).setDirectoryDisabledAt({ id: identity.id, directoryDisabledAt: null })
}

type ReconcileOnePlatformParams = {
    platformId: PlatformId
    log: FastifyBaseLogger
}

type CollectDirectoryStateParams = {
    resolved: ResolvedLdapConfig
    linkedIdentities: UserFederatedIdentity[]
    log: FastifyBaseLogger
}

type ResolveOneIdentityParams = {
    client: Client
    identity: UserFederatedIdentity
    resolved: ResolvedLdapConfig
    log: FastifyBaseLogger
}

type DeactivateUserParams = {
    identity: UserFederatedIdentity
    log: FastifyBaseLogger
}

type ReactivateIfDirectoryDisabledParams = {
    identity: UserFederatedIdentity
    log: FastifyBaseLogger
}

type GoneOrDisabledResult = { identity: UserFederatedIdentity, kind: 'gone' | 'disabled' }
type PresentResult = { identity: UserFederatedIdentity, kind: 'present', memberGroupDns: string[] }
type SkippedResult = { identity: UserFederatedIdentity, kind: 'skipped' }
type PerUserResult = GoneOrDisabledResult | PresentResult | SkippedResult
