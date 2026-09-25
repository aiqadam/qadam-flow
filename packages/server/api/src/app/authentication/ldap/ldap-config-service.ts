import { X509Certificate } from 'node:crypto'
import {
    apId,
    ErrorCode,
    isNil,
    LdapConfig,
    LdapTestRequest,
    LdapTestResponse,
    LdapTestStage,
    PlatformId,
    PlatformLdapConfig,
    QadamFlowError,
    spreadIfDefined,
    tryCatchSync,
    UpsertLdapConfigRequest,
    UserId,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Client } from 'ldapts'
import { repoFactory } from '../../core/db/repo-factory'
import { EncryptedObject, encryptUtils } from '../../helper/encryption'
import { platformService } from '../../platform/platform.service'
import { ldapClient, ResolvedLdapConnectionConfig } from './ldap-client'
import { PlatformLdapConfigEntity, PlatformLdapConfigSchema } from './ldap-config-entity'
import { LdapStageError } from './ldap-stage-error'

const platformLdapConfigRepo = repoFactory(PlatformLdapConfigEntity)

export const ldapConfigService = (log: FastifyBaseLogger) => ({
    async getOrThrow({ platformId }: PlatformScopedParams): Promise<PlatformLdapConfig> {
        const row = await platformLdapConfigRepo().findOneBy({ platformId })
        if (isNil(row)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: { entityId: platformId, entityType: 'platform_ldap_config' },
            })
        }
        return toResponse(row)
    },
    async get({ platformId }: PlatformScopedParams): Promise<PlatformLdapConfig | null> {
        const row = await platformLdapConfigRepo().findOneBy({ platformId })
        return isNil(row) ? null : toResponse(row)
    },
    // No network I/O happens here — deliberately. The directory is only ever reached from the
    // sign-in path and from the explicit `/test` endpoint below, never as a side effect of saving
    // a config an admin has not yet asked to try.
    async upsert({ platformId, callingUserId, request }: UpsertParams): Promise<PlatformLdapConfig> {
        const existing = await platformLdapConfigRepo().findOneBy({ platformId })
        // B2 (owner/admin takeover): `linkExistingByEmail: true` hands every future directory
        // entry that matches an existing local email the ability to sign in as that account.
        // Restricting who may turn it on to the platform owner is the other half of the
        // guarantee `assertIdentityIsNotPrivilegedElsewhere` enforces at sign-in time (which
        // refuses to link the owner/any admin no matter who set this flag) — without this check
        // a non-owner admin could still use the flag against every *non*-admin local account.
        if (request.linkExistingByEmail === true) {
            await assertCallerIsPlatformOwner({ platformId, callingUserId, log })
        }
        // An omitted field on update keeps the stored value; `LdapConfig.parse` both fills in the
        // defaults a brand-new config needs and re-validates the merged result (e.g. the
        // `{username}`-placeholder and URL/`tlsMode` checks), so a partial update can never leave
        // the row in a state that would not have passed validation on its own.
        const config = LdapConfig.parse({ ...existing?.config, ...request })

        // M3: a stored bind password is otherwise exfiltratable by repointing the connection at an
        // attacker-controlled host/DN and letting the server dial out with it. Any field that
        // changes what the bind password is sent to, or how the TLS channel it travels over is
        // verified, must force the caller to re-supply the password rather than silently carry the
        // old one forward onto the new destination.
        const caCertificateTouched = request.caCertificate !== undefined
        if (!isNil(existing) && isNil(request.bindPassword) && (connectionSensitiveFieldsChanged({ existing: existing.config, config }) || caCertificateTouched)) {
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
    async delete({ platformId }: PlatformScopedParams): Promise<void> {
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
            return { success: false, stage: LdapTestStage.ALLOW_LIST, message: 'No LDAP configuration is saved for this platform' }
        }
        const { config, bindPassword, connectionConfig } = await decryptForConnection(row)

        // `client` is declared outside the `try` so `finally` can always reach it: the previous
        // shape only unbound on the two success returns, so a `serviceBind`/`searchForUser` throw
        // (the entire point of this endpoint — testing a config that is expected to sometimes
        // fail) leaked the socket every time it did.
        let client: Client | undefined
        try {
            client = await ldapClient.withConnectionSlot(() => ldapClient.connect({ config: connectionConfig }))
            await ldapClient.serviceBind({ client, bindDn: config.bindDn, bindPassword })

            if (isNil(request.username) || isNil(request.password)) {
                return { success: true, stage: LdapTestStage.SUCCESS, message: 'Connected and bound with the service account' }
            }

            const entry = await ldapClient.searchForUser({
                client,
                baseDn: config.baseDn,
                userFilter: config.userFilter,
                username: request.username,
                attributeMap: config.attributeMap,
            })
            await ldapClient.bindAsUser({ config: connectionConfig, userDn: entry.dn, password: request.password })
            return { success: true, stage: LdapTestStage.SUCCESS, message: 'Signed in successfully as the test user' }
        }
        catch (thrown) {
            if (thrown instanceof LdapStageError) {
                return { success: false, stage: thrown.stage, message: thrown.message, ...spreadIfDefined('ldapResultCode', thrown.ldapResultCode) }
            }
            log.error({ err: thrown, platformId }, '[ldapConfigService#test] Unexpected error while testing LDAP configuration')
            return { success: false, stage: LdapTestStage.CONNECT, message: 'Unexpected error while testing the connection' }
        }
        finally {
            await client?.unbind().catch(() => undefined)
        }
    },
})

async function decryptForConnection(row: PlatformLdapConfigSchema): Promise<ResolvedLdapConfig> {
    const bindPassword = await encryptUtils.decryptString(row.bindPassword)
    const caCertificatePem = isNil(row.caCertificate) ? undefined : await encryptUtils.decryptString(row.caCertificate)
    return {
        config: row.config,
        bindPassword,
        connectionConfig: {
            url: row.config.url,
            tlsMode: row.config.tlsMode,
            tlsVerify: row.config.tlsVerify,
            caCertificatePem,
        },
    }
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
            params: { message: 'Only the platform owner may enable linking existing local accounts by email' },
        })
    }
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
        config: row.config,
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

type AssertCallerIsPlatformOwnerParams = {
    platformId: PlatformId
    callingUserId: UserId
    log: FastifyBaseLogger
}

type ConnectionSensitiveFieldsChangedParams = {
    existing: LdapConfig
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

export type ResolvedLdapConfig = {
    config: LdapConfig
    bindPassword: string
    connectionConfig: ResolvedLdapConnectionConfig
}
