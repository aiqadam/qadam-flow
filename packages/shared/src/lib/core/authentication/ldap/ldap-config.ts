import { z } from 'zod'
import { formErrors } from '../../../form-errors'
import { DefaultProjectRole } from '../../../management/project/project-member'
import { BaseModelSchema } from '../../common/base-model'
import { PlatformRole } from '../../user/user'

export const MIN_LDAP_SESSION_TTL_SECONDS = 3600
export const MAX_LDAP_SESSION_TTL_SECONDS = 604800
export const DEFAULT_LDAP_SESSION_TTL_SECONDS = 43200

// AD's "walk the whole nested-group chain" control extension (RFC 4511 §4.1.11 extensible-match,
// this specific OID is Microsoft's own): `(member:1.2.840.113556.1.4.1941:=<userDn>)` matches an
// entry that has the user as a direct OR transitive member, which a plain `memberOf` read on the
// user's own entry cannot express — `memberOf` only ever lists a user's *direct* group membership.
export const LDAP_MATCHING_RULE_IN_CHAIN_OID = '1.2.840.113556.1.4.1941'

// Every `projectId` here is re-validated against the configuring platform's own projects, both at
// save time (`ldapConfigService.upsert`) and again at apply time (sign-in / reconcile) — a project
// can be deleted, or a config row can predate a stricter check, after the mapping was saved.
export const LdapGroupProjectMapping = z.object({
    projectId: z.string().min(1, formErrors.required),
    role: z.enum(DefaultProjectRole),
})
export type LdapGroupProjectMapping = z.infer<typeof LdapGroupProjectMapping>

// Caps guard against an admin-authored config becoming an unbounded payload — every mapping is
// re-walked on every sign-in and every reconcile tick, so `groupMappings`/`projects` sizes feed
// directly into per-request and per-tick cost. `groupDn` matches the 1024-char cap already used
// for `username`/`password` below.
export const MAX_LDAP_GROUP_DN_LENGTH = 1024
export const MAX_LDAP_GROUP_MAPPINGS = 200
export const MAX_LDAP_GROUP_MAPPING_PROJECTS = 200

export const LdapGroupMapping = z.object({
    groupDn: z.string().min(1, 'invalidLdapGroupDn').max(MAX_LDAP_GROUP_DN_LENGTH, 'ldapGroupDnTooLong'),
    platformRole: z.enum(PlatformRole).optional(),
    projects: z.array(LdapGroupProjectMapping).max(MAX_LDAP_GROUP_MAPPING_PROJECTS, 'tooManyLdapGroupMappingProjects').default([]),
})
export type LdapGroupMapping = z.infer<typeof LdapGroupMapping>

// `projects` has no `.default([])` here, unlike `LdapGroupMapping` — a field carrying `.default(...)`
// makes `z.input` (what a caller may omit) diverge from `z.output` (what parsing always produces),
// and nesting that anywhere inside `UpsertLdapConfigRequest` was enough to break `zodResolver`'s
// `Resolver<T>` typing in `ldap-dialog.tsx` with a "two different types, but they are unrelated"
// error. Requiring `projects` here keeps this schema's `z.input`/`z.output` identical; the request
// must always supply it (empty array or not). `LdapConfig.parse` — every actual merge/parse point —
// still runs the original `LdapGroupMapping` (with its default intact) over the final merged
// config, so an omitted `projects` still backfills to `[]` there, same as before.
export const UpsertLdapGroupMapping = LdapGroupMapping.extend({
    projects: z.array(LdapGroupProjectMapping).max(MAX_LDAP_GROUP_MAPPING_PROJECTS, 'tooManyLdapGroupMappingProjects'),
})
export type UpsertLdapGroupMapping = z.infer<typeof UpsertLdapGroupMapping>

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
    // AD's `LDAP_MATCHING_RULE_IN_CHAIN` walk, gated behind its own switch since it costs the
    // directory an extra, more expensive search per sign-in/reconcile — off leaves `memberOf`
    // (direct membership only) as the only source of group membership.
    nestedGroups: z.boolean().default(false),
    // Both optional and only meaningful when `nestedGroups` is on: absent, group membership is
    // read from the signed-in entry's own `memberOf` attribute. Present, a nested-group search is
    // run against this base with this filter instead (or in addition — see ldap.md).
    groupSearchBaseDn: z.string().min(1, formErrors.required).optional(),
    groupSearchFilter: z.string().min(1, formErrors.required).optional().refine(
        (value) => value === undefined || countOccurrences({ value, needle: '{userDn}' }) === 1,
        'invalidLdapGroupSearchFilter',
    ),
    groupMappings: z.array(LdapGroupMapping).max(MAX_LDAP_GROUP_MAPPINGS, 'tooManyLdapGroupMappings').default([]),
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
    assertGroupSearchConfigIsPaired(config, ctx)
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
    // Same default-defeat footgun as the five booleans above: `nestedGroups`/`groupMappings` both
    // carry their own `.default(...)` on `ldapConfigShape`, so they need the same plain-`.optional()`
    // override here to actually parse an omitted field to `undefined` rather than the default.
    // `groupMappings` additionally swaps its element schema for `UpsertLdapGroupMapping` (see its
    // own comment) so the request's own inferred type has no default-carrying field anywhere
    // inside it.
    nestedGroups: z.boolean().optional(),
    groupMappings: z.array(UpsertLdapGroupMapping).max(MAX_LDAP_GROUP_MAPPINGS, 'tooManyLdapGroupMappings').optional(),
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
    // Phase 2: the group-membership resolution step (`memberOf`, plus the optional nested-group
    // search), exercised by `/test` only when the platform has `groupMappings` configured — its
    // own stage so a broken `groupSearchFilter` is reported distinctly from a broken user search.
    GROUP_SEARCH = 'GROUP_SEARCH',
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

// `groupSearchBaseDn` and `groupSearchFilter` are a pair: a base with no filter (or vice versa)
// cannot be turned into a search, and would otherwise silently fall back to `memberOf`-only
// resolution — the admin configured a nested-group search and got direct-membership-only instead,
// with nothing in the response telling them why.
function assertGroupSearchConfigIsPaired(config: { groupSearchBaseDn?: string, groupSearchFilter?: string }, ctx: z.RefinementCtx): void {
    const hasBaseDn = config.groupSearchBaseDn !== undefined
    const hasFilter = config.groupSearchFilter !== undefined
    if (hasBaseDn !== hasFilter) {
        ctx.addIssue({
            code: 'custom',
            message: 'invalidLdapGroupSearchConfig',
            path: ['groupSearchFilter'],
        })
    }
}

type CountOccurrencesParams = {
    value: string
    needle: string
}
