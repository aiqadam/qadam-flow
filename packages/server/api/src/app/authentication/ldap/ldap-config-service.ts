import { X509Certificate } from 'node:crypto'
import {
    apId,
    ErrorCode,
    isNil,
    LdapAttributeMap,
    LdapConfig,
    LdapGroupMapping,
    LdapTestRequest,
    LdapTestResponse,
    LdapTestStage,
    PlatformId,
    PlatformLdapConfig,
    PlatformRole,
    ProjectType,
    QadamFlowError,
    spreadIfDefined,
    tryCatch,
    tryCatchSync,
    unique,
    UpsertLdapConfigRequest,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Entry } from 'ldapts'
import { repoFactory } from '../../core/db/repo-factory'
import { EncryptedObject, encryptUtils } from '../../helper/encryption'
import { platformService } from '../../platform/platform.service'
import { projectService } from '../../project/project-service'
import { ldapAttributeUtils } from './ldap-attributes'
import { ldapClient, ResolvedLdapConnectionConfig } from './ldap-client'
import { PlatformLdapConfigEntity, PlatformLdapConfigSchema } from './ldap-config-entity'
import { ldapGroupMappingUtils } from './ldap-group-mapping'
import { LdapStageError } from './ldap-stage-error'
import { ldapUsernameUtils } from './ldap-username'

const platformLdapConfigRepo = repoFactory(PlatformLdapConfigEntity)

export const ldapConfigService = (log: FastifyBaseLogger) => ({
    async get({ platformId }: PlatformScopedParams): Promise<PlatformLdapConfig | null> {
        const row = await platformLdapConfigRepo().findOneBy({ platformId })
        return isNil(row) ? null : toResponse(row)
    },
    // Reconcile's own entry point (Phase 2): a light query for *which* platforms it has work to do
    // for, so the per-platform secret decryption (`getResolvedForSignIn`) only ever happens once
    // reconcile is actually about to process that one platform, inside its own `distributedLock`.
    async listEnabledPlatformIds(): Promise<PlatformId[]> {
        const rows = await platformLdapConfigRepo()
            .createQueryBuilder('c')
            .where('c.config->>\'enabled\' = \'true\'')
            .select('c."platformId"', 'platformId')
            .getRawMany<{ platformId: PlatformId }>()
        return rows.map((row) => row.platformId)
    },
    // No network I/O happens here — deliberately. The directory is only ever reached from the
    // sign-in path and from the explicit `/test` endpoint below, never as a side effect of saving
    // a config an admin has not yet asked to try.
    async upsert({ platformId, callingUserId, request }: UpsertParams): Promise<PlatformLdapConfig> {
        const existing = await platformLdapConfigRepo().findOneBy({ platformId })
        // A row saved before Phase 2 has no `groupMappings`/`nestedGroups`/`groupSearchBaseDn`/
        // `groupSearchFilter` at all in its stored JSON — `LdapConfig.parse` backfills each with
        // its schema default, the same way the *merged* `config` below already relies on `.parse`
        // to fill in anything neither side supplied. Every other raw read of `existing.config` in
        // this function goes through this parsed copy for the same reason.
        const existingConfig = isNil(existing) ? undefined : resolveStoredConfig(existing)
        // An omitted field on update keeps the stored value; `LdapConfig.parse` both fills in the
        // defaults a brand-new config needs and re-validates the merged result (e.g. the
        // `{username}`-placeholder and URL/`tlsMode` checks), so a partial update can never leave
        // the row in a state that would not have passed validation on its own.
        const config = LdapConfig.parse({ ...existingConfig, ...request })
        await assertGroupMappingProjectsBelongToPlatform({ platformId, groupMappings: config.groupMappings, log })
        assertGroupMappingDnsAreComparable(config.groupMappings)

        // B2 (owner/admin takeover): `linkExistingByEmail: true` hands every future directory
        // entry that matches an existing local email the ability to sign in as that account.
        // Restricting who may turn it on — and, by the same reasoning, off — to the platform
        // owner is the other half of the guarantee `assertIdentityIsNotPrivilegedElsewhere`
        // enforces at sign-in time. Phase 2 extends the same gate to a group mapping granting
        // platform ADMIN, which is exactly as powerful: any directory user in that group becomes
        // a platform admin on their next sign-in or the next reconcile pass.
        //
        // Gated on *either* the existing stored config or the merged one being sensitive, not the
        // merged one alone — gating on the merged config only would let a non-owner admin submit a
        // request that both turns `linkExistingByEmail` off (or drops the ADMIN mapping) *and*
        // repoints `url`/`bindDn`/other fields in the same call, since the *merged* result no
        // longer looks sensitive and the gate never fires, even though the request changed a
        // config that, a moment before, was. The rule this repo takes throughout: a non-owner may
        // never touch a config that is, or was, in this sensitive state, full stop — including
        // turning the sensitive flag off by itself, with no other field touched. A caller may
        // still resend the exact same config unchanged (a genuine no-op, checked by
        // `configHasChanged` below) without being the owner.
        //
        // `configHasChanged` only ever compares `LdapConfig` itself — `bindPassword` and
        // `caCertificate` are stored, and touched, entirely outside it, so a non-owner could swap
        // either one while the config stayed sensitive without the gate ever seeing a change. Both
        // are checked here explicitly, alongside `configHasChanged`, for exactly that reason.
        const secretsTouched = request.caCertificate !== undefined || !isNil(request.bindPassword)
        const wasSensitive = !isNil(existingConfig) && (existingConfig.linkExistingByEmail === true || grantsPlatformAdminViaMapping(existingConfig.groupMappings))
        const isSensitive = config.linkExistingByEmail === true || grantsPlatformAdminViaMapping(config.groupMappings)
        if ((wasSensitive || isSensitive) && (configHasChanged({ existing: existingConfig, config }) || secretsTouched)) {
            await assertCallerIsPlatformOwner({ platformId, callingUserId, log })
        }

        // M3: a stored bind password is otherwise exfiltratable by repointing the connection at an
        // attacker-controlled host/DN and letting the server dial out with it. Any field that
        // changes what the bind password is sent to, or how the TLS channel it travels over is
        // verified, must force the caller to re-supply the password rather than silently carry the
        // old one forward onto the new destination.
        const caCertificateTouched = request.caCertificate !== undefined
        if (!isNil(existingConfig) && isNil(request.bindPassword) && (connectionSensitiveFieldsChanged({ existing: existingConfig, config }) || caCertificateTouched)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'The bind password must be re-supplied when the URL, bind DN, TLS mode, TLS verification or CA certificate changes' },
            })
        }

        const bindPassword = isNil(request.bindPassword)
            ? existing?.bindPassword
            : await encryptUtils.encryptString(request.bindPassword)
        if (isNil(bindPassword)) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'A bind password is required to create an LDAP configuration' },
            })
        }

        const caCertificate = await resolveCaCertificate({ request, existing })

        const row: NewOrUpdatedRow = {
            id: existing?.id ?? apId(),
            created: existing?.created ?? new Date().toISOString(),
            updated: new Date().toISOString(),
            platformId,
            config,
            bindPassword,
            caCertificate,
        }
        const saved = await platformLdapConfigRepo().save(row)
        log.info({ platformId }, 'Saved LDAP configuration')
        return toResponse(saved)
    },
    // A non-owner admin must not be able to delete a sensitive config (`linkExistingByEmail: true`
    // or a group mapping granting ADMIN) and immediately re-create an unchanged one to dodge
    // `upsert`'s own owner gate — deleting is itself the sensitive operation here, since it
    // destroys the very row that gate was protecting. The same "existing OR merged" reasoning
    // `upsert` applies also applies to removing the row outright: there is no "merged" config on a
    // delete, only the existing one, so this checks that alone.
    async delete({ platformId, callingUserId }: DeleteParams): Promise<void> {
        const existing = await platformLdapConfigRepo().findOneBy({ platformId })
        if (!isNil(existing)) {
            const existingConfig = resolveStoredConfig(existing)
            if (existingConfig.linkExistingByEmail === true || grantsPlatformAdminViaMapping(existingConfig.groupMappings)) {
                await assertCallerIsPlatformOwner({ platformId, callingUserId, log })
            }
        }
        await platformLdapConfigRepo().delete({ platformId })
    },
    // The only two callers that ever need the decrypted bind password / CA certificate: this
    // file's own `/test` handler, and the sign-in flow in `ldap-authn-service.ts`. Never exposed
    // over HTTP — every controller-facing read goes through `toResponse` above instead.
    async getResolvedForSignIn({ platformId }: PlatformScopedParams): Promise<ResolvedLdapConfig | null> {
        const row = await platformLdapConfigRepo().findOneBy({ platformId })
        return isNil(row) ? null : decryptForConnection(row)
    },
    async test({ platformId, request }: TestParams): Promise<LdapTestResponse> {
        const row = await platformLdapConfigRepo().findOneBy({ platformId })
        if (isNil(row)) {
            // Its own stage, distinct from ALLOW_LIST: "nothing saved yet" and "the allow list
            // rejected the configured host" used to share one stage, which made this response
            // ambiguous about which of the two an admin was actually looking at.
            return { success: false, stage: LdapTestStage.NOT_CONFIGURED, message: 'No LDAP configuration is saved for this platform' }
        }
        const { config, bindPassword, connectionConfig } = await decryptForConnection(row)

        try {
            // The service-bind (+ optional search) sequence holds its own connection slot for
            // exactly its own connection's lifetime; the slot is released — this `withConnectionSlot`
            // call returns — *before* a user-bind attempt, if one is needed, opens its own separate
            // connection via `bindAsUser` (which acquires its own slot in turn, the same one
            // connection/one slot shape `lookupDirectoryUser` uses). The previous shape called
            // `bindAsUser` from *inside* this block, before its own `finally` had unbound the first
            // connection — holding two of the process-wide connection slots for the length of the
            // user bind, on top of two sockets open at once, for what a `/test` call only ever
            // needs one of at a time.
            const outcome = await ldapClient.withConnectionSlot(async (): Promise<ServiceBindOutcome> => {
                const client = await ldapClient.connect({ config: connectionConfig })
                try {
                    await ldapClient.serviceBind({ client, bindDn: config.bindDn, bindPassword, tlsMode: config.tlsMode })

                    if (isNil(request.username) || isNil(request.password)) {
                        return { kind: 'serviceOnly' }
                    }

                    const entry = await ldapClient.searchForUser({
                        client,
                        baseDn: config.baseDn,
                        userFilter: config.userFilter,
                        username: ldapUsernameUtils.normalize(request.username),
                        attributeMap: config.attributeMap,
                        tlsMode: config.tlsMode,
                    })
                    assertResolvableAttributes({ entry, attributeMap: config.attributeMap })
                    // Exercised only when the platform actually has group mappings configured — an
                    // admin testing plain sign-in on a platform with no mappings at all should not
                    // pay for (or be told about) a search step that has nothing to resolve. A
                    // failure here is its own stage, distinct from `SEARCH`, so a broken
                    // `groupSearchFilter` is reported for what it is rather than looking like the
                    // user search itself failed.
                    if (config.groupMappings.length > 0) {
                        const { error: groupError } = await tryCatch(() => ldapClient.resolveMemberGroupDns({ client, entry, config, tlsMode: config.tlsMode }))
                        if (!isNil(groupError)) {
                            throw new LdapStageError({
                                stage: LdapTestStage.GROUP_SEARCH,
                                message: `Group resolution failed: ${groupError instanceof Error ? groupError.message : 'unknown error'}`,
                            })
                        }
                    }
                    return { kind: 'userBindNeeded', userDn: entry.dn, password: request.password }
                }
                finally {
                    await client.unbind().catch(() => undefined)
                }
            })

            if (outcome.kind === 'serviceOnly') {
                return { success: true, stage: LdapTestStage.SUCCESS, message: 'Connected and bound with the service account' }
            }
            await ldapClient.bindAsUser({ config: connectionConfig, userDn: outcome.userDn, password: outcome.password })
            return { success: true, stage: LdapTestStage.SUCCESS, message: 'Signed in successfully as the test user' }
        }
        catch (thrown) {
            if (thrown instanceof LdapStageError) {
                return { success: false, stage: thrown.stage, message: thrown.message, ...spreadIfDefined('ldapResultCode', thrown.ldapResultCode) }
            }
            log.error({ err: thrown, platformId }, '[ldapConfigService#test] Unexpected error while testing LDAP configuration')
            return { success: false, stage: LdapTestStage.CONNECT, message: 'Unexpected error while testing the connection' }
        }
    },
})

// A test that only proves the search matched an entry would tell an admin nothing about the one
// failure mode `ldapAuthnService.signIn` would hit next: an entry that matches the filter but is
// missing (or has unreadable) email/subject attributes. Checking both here, the same way
// `ldapAuthnService` does, is what makes a `SUCCESS` result from `/test` an actual predictor of
// whether a real sign-in with these credentials would succeed.
function assertResolvableAttributes({ entry, attributeMap }: AssertResolvableAttributesParams): void {
    const email = ldapAttributeUtils.readStringAttribute({ entry, name: attributeMap.email })
    if (isNil(email) || email.length === 0) {
        throw new LdapStageError({
            stage: LdapTestStage.SEARCH,
            message: `The configured email attribute ("${attributeMap.email}") is missing or unreadable on the matched entry`,
        })
    }
    const subject = ldapAttributeUtils.resolveSubject({ entry, attributeMap })
    if (isNil(subject) || subject.length === 0) {
        throw new LdapStageError({
            stage: LdapTestStage.SEARCH,
            message: `The configured subject attribute ("${attributeMap.subject}") is missing or unreadable on the matched entry`,
        })
    }
}

async function decryptForConnection(row: PlatformLdapConfigSchema): Promise<ResolvedLdapConfig> {
    const config = resolveStoredConfig(row)
    const bindPassword = await encryptUtils.decryptString(row.bindPassword)
    const caCertificatePem = isNil(row.caCertificate) ? undefined : await encryptUtils.decryptString(row.caCertificate)
    return {
        config,
        bindPassword,
        connectionConfig: {
            url: config.url,
            tlsMode: config.tlsMode,
            tlsVerify: config.tlsVerify,
            caCertificatePem,
        },
    }
}

// A config row saved before Phase 2 shipped has no `groupMappings`/`nestedGroups`/
// `groupSearchBaseDn`/`groupSearchFilter` in its stored JSON at all — every reader of a *raw*
// `row.config` (this file's own `existing.config` checks, `decryptForConnection`, `toResponse`)
// must go through `LdapConfig.parse` first, the same way `upsert`'s own merged `config` already
// does, so a Phase-1-shaped row backfills each new field with its schema default instead of the
// reader crashing on a missing one (e.g. `undefined.some(...)`).
function resolveStoredConfig(row: PlatformLdapConfigSchema): LdapConfig {
    return LdapConfig.parse(row.config)
}

function grantsPlatformAdminViaMapping(groupMappings: LdapGroupMapping[]): boolean {
    return groupMappings.some((mapping) => mapping.platformRole === PlatformRole.ADMIN)
}

async function resolveCaCertificate({ request, existing }: ResolveCaCertificateParams): Promise<EncryptedObject | null> {
    if (request.caCertificate === null) {
        return null
    }
    if (isNil(request.caCertificate)) {
        return existing?.caCertificate ?? null
    }
    assertValidPem(request.caCertificate)
    return encryptUtils.encryptString(request.caCertificate)
}

function assertValidPem(pem: string): void {
    const { error } = tryCatchSync(() => new X509Certificate(pem))
    if (!isNil(error)) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: 'The CA certificate is not a valid PEM-encoded X.509 certificate' },
        })
    }
}

async function assertCallerIsPlatformOwner({ platformId, callingUserId, log }: AssertCallerIsPlatformOwnerParams): Promise<void> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    if (platform.ownerId !== callingUserId) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: { message: 'Only the platform owner may change this configuration while linking existing local accounts by email, or a group mapping granting platform ADMIN, is enabled' },
        })
    }
}

// Save-time half of the "every projectId validated to belong to the configuring platform" rule —
// the other half is `ldapGroupMappingService`'s own re-check at apply time, since a project can be
// deleted (or its type changed) after the mapping is saved. A stale or ineligible reference here
// is refused outright, not silently dropped, so an admin who typos, reuses a projectId from
// another platform, or names a PERSONAL project gets an error instead of a mapping that quietly
// never grants anything. PERSONAL projects are refused: they are one user's own workspace,
// created as an onboarding side effect, not a workspace a directory group is meant to grant shared
// access to.
async function assertGroupMappingProjectsBelongToPlatform({ platformId, groupMappings, log }: AssertGroupMappingProjectsBelongToPlatformParams): Promise<void> {
    const projectIds = unique(groupMappings.flatMap((mapping) => mapping.projects.map((project) => project.projectId)))
    for (const projectId of projectIds) {
        const project = await projectService(log).getOne(projectId)
        if (isNil(project) || project.platformId !== platformId) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Group mapping project "${projectId}" does not belong to this platform` },
            })
        }
        if (project.type !== ProjectType.TEAM) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: `Group mapping project "${projectId}" must be a TEAM project` },
            })
        }
    }
}

// A `groupDn` reconcile/sign-in can never actually compare (an attribute-value assertion with no
// `=`, or a hex escape that decodes to invalid UTF-8 — `normalizeGroupDn` returns `null` for
// either) would otherwise sit in the config forever, silently granting nothing: `resolveGrants`
// treats a `null`-normalizing mapping as never matching any reported group, by design (M2b), so
// there is no later point where this mistake becomes visible on its own. Refusing it at save time,
// the one moment an admin can still see and fix their own typo, is the only point a stored mapping
// like this is ever caught at all. Uses the i18n-key message convention (`params.message` reaches
// the client's form as-is and is translated there), matching every other zod-adjacent validation
// message this schema already carries — not the ad hoc plain-English messages elsewhere in this
// function, which predate that convention.
function assertGroupMappingDnsAreComparable(groupMappings: LdapGroupMapping[]): void {
    for (const mapping of groupMappings) {
        if (ldapGroupMappingUtils.normalizeGroupDn(mapping.groupDn) === null) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: { message: 'invalidLdapGroupDnEncoding' },
            })
        }
    }
}

// Whole-config equality, not a field-by-field allowlist — deliberately, so a future field added to
// `LdapConfig` is covered by this check for free. This only ever compares `LdapConfig` itself,
// though — `bindPassword`/`caCertificate` live outside it entirely and are never "covered for
// free" here; the caller checks those two explicitly, alongside this function's result.
// `LdapConfig.parse`'s output key order matches the schema's own declared shape regardless of the
// input's key order, so two JSON-stringified parsed configs compare equal exactly when their
// values do.
function configHasChanged({ existing, config }: ConfigHasChangedParams): boolean {
    if (isNil(existing)) {
        return true
    }
    return JSON.stringify(existing) !== JSON.stringify(config)
}

// The CA certificate is compared by presence-of-change rather than by value: it is stored
// encrypted, so telling "the same certificate re-sent" apart from "a different certificate" would
// mean decrypting on every unrelated update just to run this check. Treating any explicit touch
// to `caCertificate` (set or cleared) as a change is the safe direction to round to — it can only
// ever ask for a bind password that was going to be required anyway, never skip asking for one.
function connectionSensitiveFieldsChanged({ existing, config }: ConnectionSensitiveFieldsChangedParams): boolean {
    return existing.url !== config.url
        || existing.bindDn !== config.bindDn
        || existing.tlsVerify !== config.tlsVerify
        || existing.tlsMode !== config.tlsMode
}

function toResponse(row: PlatformLdapConfigSchema): PlatformLdapConfig {
    return {
        id: row.id,
        created: row.created,
        updated: row.updated,
        platformId: row.platformId,
        config: resolveStoredConfig(row),
        hasBindPassword: !isNil(row.bindPassword),
        hasCaCertificate: !isNil(row.caCertificate),
    }
}

type PlatformScopedParams = {
    platformId: PlatformId
}

type UpsertParams = {
    platformId: PlatformId
    callingUserId: UserId
    request: UpsertLdapConfigRequest
}

type DeleteParams = {
    platformId: PlatformId
    callingUserId: UserId
}

type AssertCallerIsPlatformOwnerParams = {
    platformId: PlatformId
    callingUserId: UserId
    log: FastifyBaseLogger
}

type AssertGroupMappingProjectsBelongToPlatformParams = {
    platformId: PlatformId
    groupMappings: LdapGroupMapping[]
    log: FastifyBaseLogger
}

type ConnectionSensitiveFieldsChangedParams = {
    existing: LdapConfig
    config: LdapConfig
}

type ConfigHasChangedParams = {
    existing: LdapConfig | undefined
    config: LdapConfig
}

type TestParams = {
    platformId: PlatformId
    request: LdapTestRequest
}

type ResolveCaCertificateParams = {
    request: UpsertLdapConfigRequest
    existing: PlatformLdapConfigSchema | null
}

type NewOrUpdatedRow = Omit<PlatformLdapConfigSchema, 'platform'>

type AssertResolvableAttributesParams = {
    entry: Entry
    attributeMap: LdapAttributeMap
}

export type ResolvedLdapConfig = {
    config: LdapConfig
    bindPassword: string
    connectionConfig: ResolvedLdapConnectionConfig
}

type ServiceBindOutcome =
    | { kind: 'serviceOnly' }
    | { kind: 'userBindNeeded', userDn: string, password: string }
