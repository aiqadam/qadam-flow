import { z } from 'zod'
import { BaseModelSchema, DateOrString, Nullable } from '../../core/common/base-model'
import { ApId } from '../../core/common/id-generator'
import { FederatedAuthnProviderConfig, FederatedAuthnProviderConfigWithoutSensitiveData } from '../../core/federated-authn'
import { SsoDomainVerification } from './sso-domain-verification'

export type PlatformId = ApId

export enum FilteredQadamBehavior {
    ALLOWED = 'ALLOWED',
    BLOCKED = 'BLOCKED',
}

export enum PlatformUsageMetric {
    ACTIVE_FLOWS = 'active-flows',
}

export const PlatformUsage = z.object({
    activeFlows: z.number(),
})

export type PlatformUsage = z.infer<typeof PlatformUsage>

export enum PlanName {
    STANDARD = 'standard',
}

export enum TeamProjectsLimit {
    NONE = 'NONE',
    ONE = 'ONE',
    UNLIMITED = 'UNLIMITED',
}

export const PlatformPlan = z.object({
    ...BaseModelSchema,
    // TODO: We have to use the enum when we finalize the plan names
    plan: Nullable(z.string()),
    platformId: z.string(),

    tablesEnabled: z.boolean(),
    eventStreamingEnabled: z.boolean(),

    environmentsEnabled: z.boolean(),
    analyticsEnabled: z.boolean(),
    showPoweredBy: z.boolean(),
    auditLogEnabled: z.boolean(),
    embeddingEnabled: z.boolean(),
    agentsEnabled: z.boolean(),
    aiProvidersEnabled: z.boolean(),
    chatEnabled: z.boolean(),
    dataManipulationEnabled: z.boolean(),
    managePiecesEnabled: z.boolean(),
    manageTemplatesEnabled: z.boolean(),
    customAppearanceEnabled: z.boolean(),
    teamProjectsLimit: z.nativeEnum(TeamProjectsLimit),
    projectRolesEnabled: z.boolean(),
    globalConnectionsEnabled: z.boolean(),
    customRolesEnabled: z.boolean(),
    apiKeysEnabled: z.boolean(),
    ssoEnabled: z.boolean(),
    secretManagersEnabled: z.boolean(),
    scimEnabled: z.boolean(),
    licenseKey: Nullable(z.string()),
    licenseExpiresAt: Nullable(DateOrString),
    stripeCustomerId: Nullable(z.string()),
    stripeSubscriptionId: Nullable(z.string()),
    stripeSubscriptionStatus: Nullable(z.string()),
    stripeSubscriptionStartDate: Nullable(z.number()),
    stripeSubscriptionEndDate: Nullable(z.number()),
    stripeSubscriptionCancelDate: Nullable(z.number()),

    projectsLimit: Nullable(z.number()),
    activeFlowsLimit: Nullable(z.number()),

    /** @deprecated use workerGroupId instead — will be removed in 0.83.0 */
    dedicatedWorkers: Nullable(z.object({
        trustedEnvironment: z.boolean(),
    })),
    /** @deprecated use workerGroupId instead — will be removed in 0.83.0 */
    canary: z.boolean(),
    /** @deprecated custom domains have been removed; column kept for backwards compatibility with existing DBs */
    customDomainsEnabled: z.boolean(),
    workerGroupId: Nullable(z.string()),
})
export type PlatformPlan = z.infer<typeof PlatformPlan>

export const PlatformPlanLimits = PlatformPlan.omit({ id: true, platformId: true, created: true, updated: true })
export type PlatformPlanLimits = z.infer<typeof PlatformPlanLimits>
export type PlatformPlanWithOnlyLimits = Omit<PlatformPlanLimits, 'stripeSubscriptionStartDate' | 'stripeSubscriptionEndDate' | 'stripeBillingCycle'>

export const Platform = z.object({
    ...BaseModelSchema,
    ownerId: ApId,
    name: z.string(),
    primaryColor: z.string(),
    logoIconUrl: z.string(),
    fullLogoUrl: z.string(),
    favIconUrl: z.string(),
    /**
    * @deprecated Use projects filter instead.
    */
    filteredQadamNames: z.array(z.string()),
    /**
    * @deprecated Use projects filter instead.
    */
    filteredQadamBehavior: z.nativeEnum(FilteredQadamBehavior),
    googleAuthEnabled: z.boolean(),
    enforceAllowedAuthDomains: z.boolean(),
    allowedAuthDomains: z.array(z.string()),
    allowedEmbedOrigins: z.array(z.string()),
    ssoDomain: Nullable(z.string()),
    ssoDomainVerification: Nullable(SsoDomainVerification),
    federatedAuthProviders: FederatedAuthnProviderConfig,
    emailAuthEnabled: z.boolean(),
    pinnedQadams: z.array(z.string()),
})
export type Platform = z.infer<typeof Platform>
export type PlatformWithoutFederatedAuth = Omit<Platform, 'federatedAuthProviders'>

export const PlatformWithoutSensitiveData = z.object({
    federatedAuthProviders: Nullable(FederatedAuthnProviderConfigWithoutSensitiveData),
    plan: PlatformPlanLimits,
    usage: PlatformUsage.optional(),
    id: z.string(),
    created: DateOrString,
    updated: DateOrString,
    ownerId: ApId,
    name: z.string(),
    primaryColor: z.string(),
    logoIconUrl: z.string(),
    fullLogoUrl: z.string(),
    favIconUrl: z.string(),
    filteredQadamNames: z.array(z.string()),
    filteredQadamBehavior: z.nativeEnum(FilteredQadamBehavior),
    googleAuthEnabled: z.boolean(),
    enforceAllowedAuthDomains: z.boolean(),
    allowedAuthDomains: z.array(z.string()),
    allowedEmbedOrigins: z.array(z.string()),
    ssoDomain: Nullable(z.string()),
    ssoDomainVerification: Nullable(SsoDomainVerification),
    emailAuthEnabled: z.boolean(),
    pinnedQadams: z.array(z.string()),
})
export type PlatformWithoutSensitiveData = z.infer<typeof PlatformWithoutSensitiveData>

export const PlatformBillingInformation = z.object({
    plan: PlatformPlan,
    usage: PlatformUsage,
    nextBillingDate: z.number(),
    nextBillingAmount: z.number(),
    cancelAt: Nullable(z.number()),
})
export type PlatformBillingInformation = z.infer<typeof PlatformBillingInformation>
