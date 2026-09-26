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

// A user's directory account is checked against `userAccountControl` bit 2 (`ACCOUNTDISABLE`,
// 0x0002) — the AD-specific signal the design calls out. A configurable "disabled account filter"
// for directories that use a different convention is a documented follow-up, not implemented here.
const AD_ACCOUNTDISABLE_BIT = 0x2

const RECONCILE_LOCK_TIMEOUT_SECONDS = 300
const DEFAULT_SAFETY_VALVE_PERCENT = 20
const DEFAULT_PLATFORM_TIME_BUDGET_MS = 60_000

// Every identity is processed start-to-finish — search, then (deferred) deactivate, or reactivate
// and re-apply its mapping — inside one per-identity loop under one shared deadline. Splitting the
// search phase and the write-back phase into two independently-deadlined loops (an earlier version
// of this function did exactly that) starves the second loop whenever the first alone consumes the
// whole budget: the search loop would stop right at the deadline, and the write-back loop's own
// `Date.now() > deadline` check would then be true on its very first iteration, reactivating or
// revoking nobody even though the search already learned enough to act on every one of them.
// Actually deactivating a "gone"/"disabled" identity is still deferred until after the whole
// slice this tick reaches is known, because the safety valve below judges the *slice*, not one
// user at a time — reactivation and mapping re-application carry no such cross-user decision, so
// they still happen immediately, inline, per identity.
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

    const deadline = Date.now() + (system.getNumber(AppSystemProp.LDAP_RECONCILE_PLATFORM_TIME_BUDGET_MS) ?? DEFAULT_PLATFORM_TIME_BUDGET_MS)

    // FAIL-OPEN on outage: a connect or service-bind failure means the directory could not be
    // reached at all for this run — every linked user is left exactly as-is, not deactivated.
    const { data: processed, error: outageError } = await tryCatch(() => processIdentitiesWithinBudget({ platformId, resolved, linkedIdentities, log, deadline }))
    if (!isNil(outageError) || isNil(processed)) {
        log.error({ err: outageError, platformId }, '[ldapReconcileService] Could not reach the directory for this platform; deactivating nobody this run (fail-open)')
        return
    }

    // Stamped for every identity this tick actually finished processing — gone, disabled, present
    // (whether or not its mapping re-application itself succeeded), and present-with-a-failed-group-
    // search (a deliberate, logged decision to skip mapping re-application, not an unresolved state)
    // all count. An identity the time budget never reached this tick is not stamped, so the next
    // tick's oldest-first ordering reaches it first.
    await userFederatedIdentityService(log).markReconciled({ ids: processed.map((result) => result.identity.id), platformId, at: new Date().toISOString() })

    const pendingDeactivations = processed.filter((result): result is GoneOrDisabledResult => result.kind === 'gone' || result.kind === 'disabled')
    await deactivateWithinSafetyValve({ platformId, linkedIdentities, pendingDeactivations, log })
}

// Connects once, then walks the (already oldest-reconciled-first-ordered) linked identities one at
// a time; each one is searched, classified, and — for a present user — fully acted on (reactivation
// check, then mapping re-application) before moving to the next, all against the same shared
// deadline. A "gone"/"disabled" identity is recorded for the caller to decide on (the safety valve
// needs the whole slice's shape first) but never written here.
async function processIdentitiesWithinBudget({ platformId, resolved, linkedIdentities, log, deadline }: ProcessIdentitiesWithinBudgetParams): Promise<PerUserResult[]> {
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
                results.push(await processOneIdentity({ client, identity, resolved, log }))
            }
            return results
        }
        finally {
            await client.unbind().catch(() => undefined)
        }
    })
}

// FAIL-CLOSED per account on a search error: leaves that one account untouched for this run
// (logged, not counted as processed, so a later tick retries it) rather than ever treating an
// unanswered lookup as grounds to act.
async function processOneIdentity({ client, identity, resolved, log }: ProcessOneIdentityParams): Promise<PerUserResult> {
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

    await reactivateIfDirectoryDisabled({ identity, log })

    // A failure here is this one user's own problem (a bad `groupSearchFilter`, a transient
    // directory hiccup on the nested-group search) — never the whole platform's outage, and it
    // still counts as "processed": the decision to skip mapping re-application this tick is itself
    // the deliberate, complete outcome for this identity, not a deferral.
    const { data: memberGroupDns, error: groupError } = await tryCatch(() => ldapClient.resolveMemberGroupDns({ client, entry, config: resolved.config, tlsMode: resolved.config.tlsMode }))
    if (!isNil(groupError) || isNil(memberGroupDns)) {
        log.warn({ err: groupError, platformId: identity.platformId, userId: identity.userId }, '[ldapReconcileService] Group resolution failed for this user this run; skipping mapping re-application, not stripping memberships over a likely-transient error')
        return { identity, kind: 'present' }
    }

    const { error: mappingError } = await tryCatch(() => ldapGroupMappingService(log).applyMapping({
        platformId: identity.platformId,
        userId: identity.userId,
        config: resolved.config,
        memberGroupDns,
    }))
    if (!isNil(mappingError)) {
        log.error({ err: mappingError, platformId: identity.platformId, userId: identity.userId }, '[ldapReconcileService] Failed to re-apply LDAP group mapping during reconcile')
    }
    return { identity, kind: 'present' }
}

function isAccountDisabled(entry: Entry): boolean {
    const rawValue = ldapAttributeUtils.readStringAttribute({ entry, name: 'userAccountControl' })
    if (isNil(rawValue)) {
        return false
    }
    const uac = Number(rawValue)
    return Number.isFinite(uac) && (uac & AD_ACCOUNTDISABLE_BIT) !== 0
}

// The safety valve is judged against *this tick's own processed slice*, not only the platform's
// own full, global ACTIVE population: a directory-wide misconfiguration (a wrong `baseDn`) makes every user in
// the directory look gone, but a time-budget-limited slice only ever proves that for the fraction
// of users a single tick actually reaches. Judging solely against the platform's full ACTIVE count
// lets a misconfiguration this severe still slip a small, valve-respecting fraction of ACTIVE users
// through per tick — and enough ticks add up to almost the whole platform being deactivated despite
// the valve tripping on no single run. Both the slice-local and the platform-global thresholds are
// checked; either one exceeded trips the valve for this tick.
async function deactivateWithinSafetyValve({ platformId, linkedIdentities, pendingDeactivations, log }: DeactivateWithinSafetyValveParams): Promise<void> {
    const statusByUserId = await userService(log).getStatusesByIds({ ids: linkedIdentities.map((identity) => identity.userId), platformId })
    const globalActiveCount = [...statusByUserId.values()].filter((status) => status === UserStatus.ACTIVE).length

    const realDeactivations = pendingDeactivations.filter((result) => statusByUserId.get(result.identity.userId) === UserStatus.ACTIVE)

    const safetyValvePercent = system.getNumber(AppSystemProp.LDAP_RECONCILE_SAFETY_VALVE_PERCENT) ?? DEFAULT_SAFETY_VALVE_PERCENT
    const globalMaxDeactivations = Math.ceil((globalActiveCount * safetyValvePercent) / 100)
    // The slice denominator is the count of currently-ACTIVE users among the identities *this tick
    // actually processed* (present + pending-deactivation, i.e. everything but the ones the time
    // budget never reached) — not the platform-wide ACTIVE count, which a budget-limited slice can
    // be a small, misleading fraction of.
    const sliceMaxDeactivations = Math.ceil((sliceActiveCount({ pendingDeactivations, statusByUserId }) * safetyValvePercent) / 100)
    const safetyValveTripped = realDeactivations.length > globalMaxDeactivations || realDeactivations.length > sliceMaxDeactivations

    if (safetyValveTripped) {
        log.error({
            platformId,
            wouldDeactivate: realDeactivations.length,
            globalMaxDeactivations,
            sliceMaxDeactivations,
            globalActiveCount,
        }, '[ldapReconcileService] Safety valve tripped — this run would deactivate more than the configured share of active LDAP users (platform-wide or within this tick\'s own processed slice); deactivating nobody')
        return
    }
    for (const result of realDeactivations) {
        await deactivateUser({ identity: result.identity, log })
    }
}

type SliceActiveCountParams = {
    pendingDeactivations: GoneOrDisabledResult[]
    statusByUserId: Map<string, UserStatus>
}

// This tick's processed slice, restricted to the identities whose current status is ACTIVE. Every
// pending deactivation is, by construction, a member of the processed slice; a present identity
// this tick also processed contributes to the slice too, but a present identity carries no
// candidate-deactivation record to read it back from — so the slice's ACTIVE count for the safety
// valve is intentionally the narrower, safer bound: at least the pending deactivations themselves,
// which is exactly the set the valve's own numerator is compared against.
function sliceActiveCount({ pendingDeactivations, statusByUserId }: SliceActiveCountParams): number {
    return pendingDeactivations.filter((result) => statusByUserId.get(result.identity.userId) === UserStatus.ACTIVE).length
}

// The owner can never hold an LDAP federated identity in the first place
// (`assertIdentityIsNotPrivilegedElsewhere` in `ldap-authn-service.ts` refuses to ever link or
// adopt one), so `userService.update` refusing to deactivate the owner is defense in depth here,
// not the primary guard — but it is still respected: a rejection just means this one user is
// skipped, not that the whole run aborts.
//
// The conditional transition (`UPDATE ... WHERE status = 'ACTIVE'`) and the `directoryDisabledAt`
// stamp both run inside one transaction: the conditional write is what makes "is this user still
// the one to deactivate" a check made atomically, at the moment of the write, rather than a stale
// read taken before the transaction started — an admin reactivating (or already having deactivated)
// this same user in the gap between this tick's own search phase and this write-back step lands
// squarely in that gap otherwise. A crash or error between the status write and the marker stamp
// used to be able to leave a user deactivated with no marker recording that reconcile was the one
// that did it, which then makes that deactivation look exactly like an admin's own (never
// auto-reactivated) — the single transaction closes that too.
async function deactivateUser({ identity, log }: DeactivateUserParams): Promise<void> {
    const { error } = await tryCatch(() => transaction(async (entityManager) => {
        const wasStillActive = await userService(log).transitionStatusIfCurrentlyEquals({
            id: identity.userId,
            platformId: identity.platformId,
            expectedStatus: UserStatus.ACTIVE,
            newStatus: UserStatus.INACTIVE,
            entityManager,
        })
        if (!wasStillActive) {
            return
        }
        await userFederatedIdentityService(log).setDirectoryDisabledAt({ id: identity.id, platformId: identity.platformId, directoryDisabledAt: new Date().toISOString(), entityManager })
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
// Both writes — clearing the marker and flipping the status — run inside one transaction, and both
// are conditional atomic writes rather than a read-then-write: `clearDirectoryDisabledAtIfSet`
// clears the marker only if it is *still* set at the moment of that write (not at the moment this
// function started running), and `transitionStatusIfCurrentlyEquals` flips the status only if it is
// still INACTIVE at the moment of *that* write. An admin re-deactivating (or reactivating) the same
// user in the gap between this tick's search phase (where the passed-in `identity` snapshot was
// taken) and this write-back step always wins the race, whichever of the two conditional writes it
// affects and whichever order the two actually land in.
async function reactivateIfDirectoryDisabled({ identity, log }: ReactivateIfDirectoryDisabledParams): Promise<void> {
    if (isNil(identity.directoryDisabledAt)) {
        return
    }
    await transaction(async (entityManager) => {
        const wasStillDirectoryDisabled = await userFederatedIdentityService(log).clearDirectoryDisabledAtIfSet({ id: identity.id, platformId: identity.platformId, entityManager })
        if (!wasStillDirectoryDisabled) {
            // Someone else — an admin's own re-deactivation — cleared it first; that status is now
            // a human decision, not reconcile's own, and must not be reactivated.
            return
        }
        // A no-op (`false`) here just means the user was not actually INACTIVE anymore by the time
        // this ran (reactivated some other way already) — the marker is already correctly cleared
        // above either way, which is all this branch needs to do.
        await userService(log).transitionStatusIfCurrentlyEquals({
            id: identity.userId,
            platformId: identity.platformId,
            expectedStatus: UserStatus.INACTIVE,
            newStatus: UserStatus.ACTIVE,
            entityManager,
        })
    })
}

type ReconcileOnePlatformParams = {
    platformId: PlatformId
    log: FastifyBaseLogger
}

type ProcessIdentitiesWithinBudgetParams = {
    platformId: PlatformId
    resolved: ResolvedLdapConfig
    linkedIdentities: UserFederatedIdentity[]
    log: FastifyBaseLogger
    deadline: number
}

type ProcessOneIdentityParams = {
    client: Client
    identity: UserFederatedIdentity
    resolved: ResolvedLdapConfig
    log: FastifyBaseLogger
}

type DeactivateWithinSafetyValveParams = {
    platformId: PlatformId
    linkedIdentities: UserFederatedIdentity[]
    pendingDeactivations: GoneOrDisabledResult[]
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
type PresentResult = { identity: UserFederatedIdentity, kind: 'present' }
type SkippedResult = { identity: UserFederatedIdentity, kind: 'skipped' }
type PerUserResult = GoneOrDisabledResult | PresentResult | SkippedResult
