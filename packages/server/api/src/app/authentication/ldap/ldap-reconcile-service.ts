import { FederatedIdentityProvider, isNil, PlatformId, tryCatch, UserFederatedIdentity, UserStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Client, Entry } from 'ldapts'
import { transaction } from '../../core/db/transaction'
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
const DEFAULT_SAFETY_VALVE_PERCENT = 20
const DEFAULT_PLATFORM_TIME_BUDGET_MS = 60_000

export const ldapReconcileService = (log: FastifyBaseLogger) => ({
    // The system job's own handler (`ldap-reconcile-module.ts`) calls this once per tick. One
    // platform's failure — an outage, a lock timeout, anything `reconcileOnePlatform` doesn't
    // already turn into a same-platform no-op — must never stop the remaining platforms from being
    // reconciled in the same run. Single-job design (not one BullMQ schedule per platform):
    // simpler, no per-platform schedule bookkeeping as platforms are added/removed, and the
    // per-platform time budget below already bounds one platform's worst case within a tick.
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

    // Round 3 (app-sec finding #5): oldest-reconciled-first (`NULLS FIRST`) — the order the time
    // budget below slices into is what rotates which users get attempted this tick, so a slow/huge
    // directory starves a *different* slice each run rather than always the same tail of the list.
    const linkedIdentities = await userFederatedIdentityService(log).listByPlatformAndProvider({
        platformId,
        provider: FederatedIdentityProvider.LDAP,
    })
    if (linkedIdentities.length === 0) {
        return
    }

    const deadline = Date.now() + (system.getNumber(AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) ?? DEFAULT_PLATFORM_TIME_BUDGET_MS)

    // FAIL-OPEN on outage: a connect or service-bind failure means the directory could not be
    // reached at all for this run — every linked user is left exactly as-is, not deactivated.
    const { data: results, error: outageError } = await tryCatch(() => collectDirectoryState({ platformId, resolved, linkedIdentities, log, deadline }))
    if (!isNil(outageError) || isNil(results)) {
        log.error({ err: outageError, platformId }, '[ldapReconcileService] Could not reach the directory for this platform; deactivating nobody this run (fail-open)')
        return
    }

    // Round 3 (app-sec finding #5): every identity the search phase actually resolved (any of
    // gone/disabled/present/skipped — attempted within budget, regardless of outcome) is stamped
    // now, before the write-back phase below, which is itself separately bounded by the same
    // deadline and may stop before finishing all of them.
    await userFederatedIdentityService(log).markReconciled({ ids: results.map((result) => result.identity.id), at: new Date().toISOString() })

    const goneOrDisabled = results.filter((result): result is GoneOrDisabledResult => result.kind === 'gone' || result.kind === 'disabled')
    const present = results.filter((result): result is PresentResult => result.kind === 'present')

    // Round 2 (app-sec finding #2): the valve must count only *real transitions*, not every
    // gone/disabled result — a user already INACTIVE (manually, or from a previous reconcile tick)
    // deactivating them again is a no-op, not a fresh departure, and must not inflate the count
    // that trips the valve. The denominator is the count of currently-ACTIVE linked users, not
    // every linked user ever — an already-mostly-inactive platform must not make the valve harder
    // to trip for the still-active minority a wrong `baseDn` would actually be affecting.
    // Round 3 (app-sec finding #5): one `IN (...)` query instead of N concurrent `getOrThrow` calls.
    const statusByUserId = await userService(log).getStatusesByIds({ ids: linkedIdentities.map((identity) => identity.userId) })
    const activeLinkedCount = [...statusByUserId.values()].filter((status) => status === UserStatus.ACTIVE).length
    const realDeactivations = goneOrDisabled.filter((result) => statusByUserId.get(result.identity.userId) === UserStatus.ACTIVE)

    const safetyValvePercent = system.getNumber(AppSystemProp.LDAP_RECONCILE_SAFETY_VALVE_PERCENT) ?? DEFAULT_SAFETY_VALVE_PERCENT
    const maxDeactivations = Math.ceil((activeLinkedCount * safetyValvePercent) / 100)
    const safetyValveTripped = realDeactivations.length > maxDeactivations

    if (safetyValveTripped) {
        log.error({
            platformId,
            wouldDeactivate: realDeactivations.length,
            maxDeactivations,
            activeLinkedCount,
        }, '[ldapReconcileService] Safety valve tripped — this run would deactivate more than the configured share of active LDAP users; deactivating nobody')
    }
    else {
        for (const result of realDeactivations) {
            await deactivateUser({ identity: result.identity, log })
        }
    }

    // Round 3 (app-sec finding #5): this write-back loop is itself bounded by the same deadline the
    // search phase used — a large `present` batch of fast per-user LDAP lookups (which leaves
    // plenty of the budget still unspent) could otherwise still spend an unbounded amount of *this*
    // platform's turn on local DB writes alone. Stopping early here just leaves the remaining
    // present users' reactivation/mapping re-application for the next tick, the same as the search
    // phase leaving unattempted users for next time — both are idempotent to repeat.
    for (const result of present) {
        if (Date.now() > deadline) {
            log.warn({ platformId }, '[ldapReconcileService] Per-platform time budget exceeded during reactivation/mapping re-application; remaining present users picked up on the next run')
            break
        }
        const { error: reactivateError } = await tryCatch(() => reactivateIfDirectoryDisabled({ identity: result.identity, log }))
        if (!isNil(reactivateError)) {
            log.warn({ err: reactivateError, platformId, userId: result.identity.userId }, '[ldapReconcileService] Could not reactivate this user this run')
        }
        // Round 2 (app-sec finding #3): a broken group search for one user (`null`, logged inside
        // `resolveOneIdentity`) must not strip that user's directory-managed memberships over what
        // is likely transient — skip re-applying the mapping for them this tick, and keep
        // processing every other present user normally.
        const { memberGroupDns } = result
        if (isNil(memberGroupDns)) {
            log.warn({ platformId, userId: result.identity.userId }, '[ldapReconcileService] Skipping group-mapping re-application for this user; group resolution failed this run')
            continue
        }
        const { error: mappingError } = await tryCatch(() => ldapGroupMappingService(log).applyMapping({
            platformId,
            userId: result.identity.userId,
            config: resolved.config,
            memberGroupDns,
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
//
// Round 2 (app-sec finding #12): bounded by a per-platform time budget so one slow or huge
// directory can't starve every other platform's own turn in the same tick — the loop simply stops
// early, leaving the remaining linked users untouched (picked up again on the next scheduled run),
// rather than blocking the whole `reconcileAllPlatforms` loop indefinitely. Round 3 (app-sec finding
// #5) moved the deadline computation up into the caller, since the write-back phase after this one
// needs to share it rather than getting a fresh budget of its own.
async function collectDirectoryState({ platformId, resolved, linkedIdentities, log, deadline }: CollectDirectoryStateParams): Promise<PerUserResult[]> {
    return ldapClient.withConnectionSlot(async () => {
        const client = await ldapClient.connect({ config: resolved.connectionConfig })
        try {
            await ldapClient.serviceBind({ client, bindDn: resolved.config.bindDn, bindPassword: resolved.bindPassword, tlsMode: resolved.config.tlsMode })
            const results: PerUserResult[] = []
            for (const identity of linkedIdentities) {
                if (Date.now() > deadline) {
                    log.warn({ platformId, processed: results.length, total: linkedIdentities.length }, '[ldapReconcileService] Per-platform time budget exceeded; stopping early for this tick, remaining users picked up on the next run')
                    break
                }
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
    // A failure here is this one user's own problem (a bad `groupSearchFilter`, a transient
    // directory hiccup on the nested-group search) — never the whole platform's outage, and never
    // grounds to skip *this* user's presence/enabled result, only their mapping re-application.
    const { data: memberGroupDns, error: groupError } = await tryCatch(() => ldapClient.resolveMemberGroupDns({ client, entry, config: resolved.config, tlsMode: resolved.config.tlsMode }))
    if (!isNil(groupError)) {
        log.warn({ err: groupError, platformId: identity.platformId, userId: identity.userId }, '[ldapReconcileService] Group resolution failed for this user this run')
        return { identity, kind: 'present', memberGroupDns: null }
    }
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
//
// Round 3 (app-sec finding #7): the status write and the `directoryDisabledAt` stamp now commit in
// one transaction — a crash or error between the two used to be able to leave a user deactivated
// with no marker recording that reconcile was the one that did it, which would then make that
// deactivation look exactly like an admin's own (never auto-reactivated).
async function deactivateUser({ identity, log }: DeactivateUserParams): Promise<void> {
    const user = await userService(log).getOrThrow({ id: identity.userId })
    if (user.status === UserStatus.INACTIVE) {
        return
    }
    const { error } = await tryCatch(() => transaction(async (entityManager) => {
        await userService(log).update({ id: identity.userId, platformId: identity.platformId, status: UserStatus.INACTIVE, source: 'LDAP', entityManager })
        await userFederatedIdentityService(log).setDirectoryDisabledAt({ id: identity.id, directoryDisabledAt: new Date().toISOString(), entityManager })
    }))
    if (!isNil(error)) {
        log.warn({ err: error, userId: identity.userId, platformId: identity.platformId }, '[ldapReconcileService] Could not deactivate a user this run')
    }
}

// Reactivates only a user *this* reconcile job itself deactivated (`directoryDisabledAt` set) —
// never a user an admin deactivated by hand, which never carries this marker (and, since
// `userService.update`'s admin path now clears it on every explicit status write, can never
// reacquire one without reconcile itself setting it again).
//
// Round 3 (app-sec finding #6): the `identity` passed in is a snapshot taken during the earlier
// search phase — potentially the other side of this platform's whole time budget away from this
// write-back phase running. An admin re-deactivating (or reactivating) the same user in between
// also clears this exact marker, and a stale read-then-write here could otherwise silently
// reactivate a user an admin just, moments ago, deliberately deactivated. `clearDirectoryDisabledAtIfSet`
// is the atomic gate: it clears the marker (and reports whether it did) only if the marker is
// *still* set at the moment of that write, not at the moment this function started running — so a
// concurrent admin clear always wins the race, whichever order the two actually land in.
async function reactivateIfDirectoryDisabled({ identity, log }: ReactivateIfDirectoryDisabledParams): Promise<void> {
    if (isNil(identity.directoryDisabledAt)) {
        return
    }
    const user = await userService(log).getOrThrow({ id: identity.userId })
    if (user.status !== UserStatus.INACTIVE) {
        // Reactivated some other way already (or never actually deactivated) — clear the stale
        // marker so a future disable-then-reconcile cycle is tracked correctly from a clean state.
        // A concurrent clear here (this call returning `false`) is a no-op either way.
        await userFederatedIdentityService(log).clearDirectoryDisabledAtIfSet({ id: identity.id })
        return
    }
    const wasStillDirectoryDisabled = await userFederatedIdentityService(log).clearDirectoryDisabledAtIfSet({ id: identity.id })
    if (!wasStillDirectoryDisabled) {
        // Someone else — an admin's own re-deactivation — cleared it first; that INACTIVE status
        // is now a human decision, not reconcile's own, and must not be reactivated.
        return
    }
    await userService(log).update({ id: identity.userId, platformId: identity.platformId, status: UserStatus.ACTIVE, source: 'LDAP' })
}

type ReconcileOnePlatformParams = {
    platformId: PlatformId
    log: FastifyBaseLogger
}

type CollectDirectoryStateParams = {
    platformId: PlatformId
    resolved: ResolvedLdapConfig
    linkedIdentities: UserFederatedIdentity[]
    log: FastifyBaseLogger
    deadline: number
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
type PresentResult = { identity: UserFederatedIdentity, kind: 'present', memberGroupDns: string[] | null }
type SkippedResult = { identity: UserFederatedIdentity, kind: 'skipped' }
type PerUserResult = GoneOrDisabledResult | PresentResult | SkippedResult
