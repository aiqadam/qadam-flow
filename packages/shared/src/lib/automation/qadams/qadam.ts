import { z } from 'zod'

export enum PackageType {
    ARCHIVE = 'ARCHIVE',
    REGISTRY = 'REGISTRY',
}

export enum QadamType {
    CUSTOM = 'CUSTOM',
    OFFICIAL = 'OFFICIAL',
}

export const PrivateQadamPackage = z.object({
    packageType: z.literal(PackageType.ARCHIVE),
    qadamType: z.nativeEnum(QadamType),
    qadamName: z.string(),
    qadamVersion: z.string(),
    archiveId: z.string(),
    platformId: z.string(),
})

export type PrivateQadamPackage = z.infer<typeof PrivateQadamPackage>

export const OfficialQadamPackage = z.object({
    packageType: z.literal(PackageType.REGISTRY),
    qadamType: z.literal(QadamType.OFFICIAL),
    qadamName: z.string(),
    qadamVersion: z.string(),
})

export type OfficialQadamPackage = z.infer<typeof OfficialQadamPackage>

export const CustomNpmQadamPackage = z.object({
    packageType: z.literal(PackageType.REGISTRY),
    qadamType: z.literal(QadamType.CUSTOM),
    qadamName: z.string(),
    qadamVersion: z.string(),
    platformId: z.string(),
})

export type CustomNpmQadamPackage = z.infer<typeof CustomNpmQadamPackage>

export const PublicQadamPackage = z.union([OfficialQadamPackage, CustomNpmQadamPackage])
export type PublicQadamPackage = OfficialQadamPackage | CustomNpmQadamPackage

export const QadamPackage = z.union([PrivateQadamPackage, OfficialQadamPackage, CustomNpmQadamPackage])
export type QadamPackage = PrivateQadamPackage | OfficialQadamPackage | CustomNpmQadamPackage

export enum QadamCategory {
    ARTIFICIAL_INTELLIGENCE = 'ARTIFICIAL_INTELLIGENCE',
    COMMUNICATION = 'COMMUNICATION',
    COMMERCE = 'COMMERCE',
    CORE = 'CORE',
    UNIVERSAL_AI = 'UNIVERSAL_AI',
    FLOW_CONTROL = 'FLOW_CONTROL',
    BUSINESS_INTELLIGENCE = 'BUSINESS_INTELLIGENCE',
    ACCOUNTING = 'ACCOUNTING',
    PRODUCTIVITY = 'PRODUCTIVITY',
    CONTENT_AND_FILES = 'CONTENT_AND_FILES',
    DEVELOPER_TOOLS = 'DEVELOPER_TOOLS',
    CUSTOMER_SUPPORT = 'CUSTOMER_SUPPORT',
    FORMS_AND_SURVEYS = 'FORMS_AND_SURVEYS',
    HUMAN_RESOURCES = 'HUMAN_RESOURCES',
    PAYMENT_PROCESSING = 'PAYMENT_PROCESSING',
    MARKETING = 'MARKETING',
    SALES_AND_CRM = 'SALES_AND_CRM',
}
