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

export const LdapAttributeMap = z.object({
    subject: z.string().min(1, formErrors.required),
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
        (value) => countOccurrences(value, '{username}') === 1,
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
// `tlsMode` only ever names the two encrypted forms (RFC 4513 ยง3), and the scheme check below
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
    ALLOW_LIST = 'ALLOW_LIST',
    CONNECT = 'CONNECT',
    SERVICE_BIND = 'SERVICE_BIND',
    SEARCH = 'SEARCH',
    USER_BIND = 'USER_BIND',
    SUCCESS = 'SUCCESS',
}

export const LdapTestRequest = z.object({
    username: z.string().min(1).max(256).optional(),
    password: z.string().min(1).max(1024).optional(),
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

function matchesTlsScheme(config: { url: string, tlsMode: LdapTlsMode }): boolean {
    const expectedScheme = config.tlsMode === LdapTlsMode.LDAPS ? 'ldaps://' : 'ldap://'
    return config.url.toLowerCase().startsWith(expectedScheme)
}

function countOccurrences(value: string, needle: string): number {
    return value.split(needle).length - 1
}
