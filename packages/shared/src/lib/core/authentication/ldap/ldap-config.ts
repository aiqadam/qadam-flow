import { z } from 'zod'
import { formErrors } from '../../../form-errors'
import { BaseModelSchema } from '../../common/base-model'

export const MIN_LDAP_SESSION_TTL_SECONDS = 3600
export const MAX_LDAP_SESSION_TTL_SECONDS = 604800
export const DEFAULT_LDAP_SESSION_TTL_SECONDS = 43200

export enum LdapTlsMode {
    LDAPS = 'ldaps',
    STARTTLS = 'starttls',
}

// Restricted to the two attributes every major directory guarantees are both unique and
// immutable for the life of the entry (AD's `objectGUID`, OpenLDAP's `entryUUID`) — an
// operator-chosen custom attribute here (e.g. `uid`, `mail`) would let whoever controls the
// directory repoint a Qadam Flow account to a different real person simply by editing that
// attribute on an existing entry, with no admin-side re-link step to notice it. The UI's own
// subject-attribute field is a select over exactly these two values for the same reason.
export const LdapSubjectAttribute = z.enum(['objectGUID', 'entryUUID'])
export type LdapSubjectAttribute = z.infer<typeof LdapSubjectAttribute>

export const LdapAttributeMap = z.object({
    subject: LdapSubjectAttribute,
    email: z.string().min(1, formErrors.required),
    firstName: z.string().min(1, formErrors.required),
    lastName: z.string().min(1, formErrors.required),
})
export type LdapAttributeMap = z.infer<typeof LdapAttributeMap>

const ldapConfigShape = {
    url: z.string().min(1, formErrors.required),
    tlsMode: z.enum(LdapTlsMode),
    baseDn: z.string().min(1, formErrors.required),
    bindDn: z.string().min(1, formErrors.required),
    userFilter: z.string().min(1, formErrors.required).refine(
        (value) => countOccurrences({ value, needle: '{username}' }) === 1,
        'invalidLdapUserFilter',
    ),
    attributeMap: LdapAttributeMap,
    tlsVerify: z.boolean().default(true),
    jitProvisioning: z.boolean().default(true),
    linkExistingByEmail: z.boolean().default(false),
    sessionTtlSeconds: z.number().int()
        .min(MIN_LDAP_SESSION_TTL_SECONDS, 'invalidLdapSessionTtl')
        .max(MAX_LDAP_SESSION_TTL_SECONDS, 'invalidLdapSessionTtl')
        .default(DEFAULT_LDAP_SESSION_TTL_SECONDS),
    enabled: z.boolean().default(false),
}

// A directory login page cannot be more permissive than the transport it authenticates over —
// `tlsMode` only ever names the two encrypted forms (RFC 4513 §3), and the scheme check below
// pins the URL to the one that matches, so a plaintext `ldap://` config with no StartTLS upgrade
// is structurally unrepresentable rather than merely discouraged.
export const LdapConfig = z.object(ldapConfigShape).superRefine((config, ctx) => {
    if (!matchesTlsScheme(config)) {
        ctx.addIssue({
            code: 'custom',
            message: 'invalidLdapUrlForTlsMode',
            path: ['url'],
        })
    }
})
export type LdapConfig = z.infer<typeof LdapConfig>

export const UpsertLdapConfigRequest = z.object(ldapConfigShape).partial({
    tlsVerify: true,
    jitProvisioning: true,
    linkExistingByEmail: true,
    sessionTtlSeconds: true,
    enabled: true,
}).extend({
    // `.partial()` alone is not enough for these five: in this zod version, `.optional()` layered
    // on top of a field's own `.default(...)` (from `ldapConfigShape`, shared with `LdapConfig`)
    // does *not* defeat the default — omitting the field on an update still parsed to the schema's
    // default value, not `undefined`, silently resetting `linkExistingByEmail`/`tlsVerify`/
    // `jitProvisioning`/`sessionTtlSeconds`/`enabled` to their base defaults on *any* partial update
    // that did not explicitly resend them — the exact opposite of "an omitted field on update keeps
    // the stored value" `ldapConfigService.upsert` depends on (and B2's owner-only gate depends on
    // that promise holding for `linkExistingByEmail` specifically). Redefining each one here with
    // no `.default()` of its own — plain `.optional()` — is what actually makes an omitted field
    // parse to `undefined`.
    tlsVerify: z.boolean().optional(),
    jitProvisioning: z.boolean().optional(),
    linkExistingByEmail: z.boolean().optional(),
    sessionTtlSeconds: z.number().int()
        .min(MIN_LDAP_SESSION_TTL_SECONDS, 'invalidLdapSessionTtl')
        .max(MAX_LDAP_SESSION_TTL_SECONDS, 'invalidLdapSessionTtl')
        .optional(),
    enabled: z.boolean().optional(),
    // Omitted keeps the value already stored for the platform; present-and-empty is refused
    // (never a way to blank out the bind account) so the only way to clear a credential is
    // deleting the whole config.
    bindPassword: z.string().min(1, formErrors.required).optional(),
    // `null` clears a previously stored CA certificate (falls back to the system trust store);
    // omitted keeps whatever is stored; a non-empty string replaces it after PEM validation.
    caCertificate: z.string().min(1, formErrors.required).nullable().optional(),
}).superRefine((config, ctx) => {
    if (!matchesTlsScheme(config)) {
        ctx.addIssue({
            code: 'custom',
            message: 'invalidLdapUrlForTlsMode',
            path: ['url'],
        })
    }
})
export type UpsertLdapConfigRequest = z.infer<typeof UpsertLdapConfigRequest>

export const PlatformLdapConfig = z.object({
    ...BaseModelSchema,
    platformId: z.string(),
    config: LdapConfig,
    hasBindPassword: z.boolean(),
    hasCaCertificate: z.boolean(),
})
export type PlatformLdapConfig = z.infer<typeof PlatformLdapConfig>

export enum LdapTestStage {
    // "Nothing saved for this platform yet" is not the same failure as "the allow list rejected
    // the configured host" — the two used to share ALLOW_LIST, which made /test's response
    // ambiguous about which one an admin was looking at.
    NOT_CONFIGURED = 'NOT_CONFIGURED',
    ALLOW_LIST = 'ALLOW_LIST',
    CONNECT = 'CONNECT',
    SERVICE_BIND = 'SERVICE_BIND',
    SEARCH = 'SEARCH',
    USER_BIND = 'USER_BIND',
    SUCCESS = 'SUCCESS',
}

export const LdapTestRequest = z.object({
    username: z.string().min(1, formErrors.required).max(256, 'invalidLdapUsername').optional(),
    password: z.string().min(1, formErrors.required).max(1024, 'invalidLdapPassword').optional(),
}).refine(
    (value) => (value.username === undefined) === (value.password === undefined),
    { message: 'invalidLdapTestCredentials', path: ['password'] },
)
export type LdapTestRequest = z.infer<typeof LdapTestRequest>

export const LdapTestResponse = z.object({
    success: z.boolean(),
    stage: z.enum(LdapTestStage),
    message: z.string(),
    ldapResultCode: z.number().optional(),
})
export type LdapTestResponse = z.infer<typeof LdapTestResponse>

// Exported so `ldap-client.ts`'s `connect()` can re-assert the same rule at connect time, as
// defense in depth against a row that predates this check or was written directly to the
// database — a plaintext `ldap://` config with no StartTLS upgrade must stay unrepresentable
// all the way down to the socket, not just at the validation boundary.
export function matchesTlsScheme(config: { url: string, tlsMode: LdapTlsMode }): boolean {
    const expectedScheme = config.tlsMode === LdapTlsMode.LDAPS ? 'ldaps://' : 'ldap://'
    return config.url.toLowerCase().startsWith(expectedScheme)
}

function countOccurrences({ value, needle }: CountOccurrencesParams): number {
    return value.split(needle).length - 1
}

type CountOccurrencesParams = {
    value: string
    needle: string
}
