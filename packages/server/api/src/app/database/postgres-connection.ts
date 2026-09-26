import { TlsOptions } from 'node:tls'
import 'pg'
import { isNil, spreadIfDefined } from '@aiqadam/shared'
import { DataSource } from 'typeorm'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { commonProperties } from './database-connection'
import { Migration } from './migration'
import { BaselineQadamFlow1750000000000 } from './migration/postgres/1750000000000-BaselineQadamFlow'
import { AddProjectMemberTable1784284221314 } from './migration/postgres/1784284221314-AddProjectMemberTable'
import { AddOtpEntity1784713964706 } from './migration/postgres/1784713964706-AddOtpEntity'
import { AddAlertEntity1784724891352 } from './migration/postgres/1784724891352-AddAlertEntity'
import { AddApiKey1784922234136 } from './migration/postgres/1784922234136-AddApiKey'
import { FixEntityMetadataDrift1785100000000 } from './migration/postgres/1785100000000-FixEntityMetadataDrift'
import { AddChatConversation1785486141722 } from './migration/postgres/1785486141722-AddChatConversation'
import { AllowMultipleCustomAIProviders1785490000000 } from './migration/postgres/1785490000000-AllowMultipleCustomAIProviders'
import { AddFlowRunDispatchMode1789026491526 } from './migration/postgres/1789026491526-AddFlowRunDispatchMode'
import { AddStoreEntryExpiresAt1789204010898 } from './migration/postgres/1789204010898-AddStoreEntryExpiresAt'
import { BackfillLogoFlowLockup1789800000000 } from './migration/postgres/1789800000000-BackfillLogoFlowLockup'
import { AddTableKeyDeclaration1789832775045 } from './migration/postgres/1789832775045-AddTableKeyDeclaration'
import { AddParentWaitpointIdToFlowRun1790116373829 } from './migration/postgres/1790116373829-AddParentWaitpointIdToFlowRun'
import { BackfillParentWaitpointIdFlowRun1790200000000 } from './migration/postgres/1790200000000-BackfillParentWaitpointIdFlowRun'
import { DeleteCustomQadamsUnderOfficialScope1790300000000 } from './migration/postgres/1790300000000-DeleteCustomQadamsUnderOfficialScope'
import { AddJoinWaitpointSlots1790400000000 } from './migration/postgres/1790400000000-AddJoinWaitpointSlots'
import { AddLdapConfigAndFederatedIdentity1790400100000 } from './migration/postgres/1790400100000-AddLdapConfigAndFederatedIdentity'
import { AddTranslationTable1790500000000 } from './migration/postgres/1790500000000-AddTranslationTable'
import { AddProjectDefaultLocale1790600000000 } from './migration/postgres/1790600000000-AddProjectDefaultLocale'
import { AddFlowVersionLocaleSource1790700000000 } from './migration/postgres/1790700000000-AddFlowVersionLocaleSource'
import { BackfillTranslationPermissionsOnDefaultRoles1790800000000 } from './migration/postgres/1790800000000-BackfillTranslationPermissionsOnDefaultRoles'
import { AddInheritedRunLocaleToFlowRun1790900000000 } from './migration/postgres/1790900000000-AddInheritedRunLocaleToFlowRun'
import { AddTranslationProjectForeignKey1791000000000 } from './migration/postgres/1791000000000-AddTranslationProjectForeignKey'
import { AddLdapGroupMappingColumns1791100000000 } from './migration/postgres/1791100000000-AddLdapGroupMappingColumns'
import { AddPlatformRoleManagedByToUser1791200000000 } from './migration/postgres/1791200000000-AddPlatformRoleManagedByToUser'
import { AddLastReconciledAtToUserFederatedIdentity1791300000000 } from './migration/postgres/1791300000000-AddLastReconciledAtToUserFederatedIdentity'

const getSslConfig = (): boolean | TlsOptions => {
    const useSsl = system.get(AppSystemProp.POSTGRES_USE_SSL)
    if (useSsl === 'true') {
        return {
            ca: system.get(AppSystemProp.POSTGRES_SSL_CA)?.replace(/\\n/g, '\n'),
        }
    }
    return false
}

export const getMigrations = (): (new () => Migration)[] => {
    return [
        BaselineQadamFlow1750000000000,
        AddProjectMemberTable1784284221314,
        AddOtpEntity1784713964706,
        AddAlertEntity1784724891352,
        AddApiKey1784922234136,
        FixEntityMetadataDrift1785100000000,
        AddChatConversation1785486141722,
        AllowMultipleCustomAIProviders1785490000000,
        AddFlowRunDispatchMode1789026491526,
        AddStoreEntryExpiresAt1789204010898,
        BackfillLogoFlowLockup1789800000000,
        AddTableKeyDeclaration1789832775045,
        AddParentWaitpointIdToFlowRun1790116373829,
        BackfillParentWaitpointIdFlowRun1790200000000,
        DeleteCustomQadamsUnderOfficialScope1790300000000,
        AddJoinWaitpointSlots1790400000000,
        AddLdapConfigAndFederatedIdentity1790400100000,
        AddTranslationTable1790500000000,
        AddProjectDefaultLocale1790600000000,
        AddFlowVersionLocaleSource1790700000000,
        BackfillTranslationPermissionsOnDefaultRoles1790800000000,
        AddInheritedRunLocaleToFlowRun1790900000000,
        AddTranslationProjectForeignKey1791000000000,
        AddLdapGroupMappingColumns1791100000000,
        AddPlatformRoleManagedByToUser1791200000000,
        AddLastReconciledAtToUserFederatedIdentity1791300000000,
    ]
}

export const createPostgresDataSource = (): DataSource => {
    const migrationConfig: MigrationConfig = {
        migrationsRun: true,
        migrationsTransactionMode: 'each',
        migrations: getMigrations(),
        synchronize: false,
    }

    const url = system.get(AppSystemProp.POSTGRES_URL)

    if (!isNil(url)) {
        return new DataSource({
            type: 'postgres',
            url,
            ssl: getSslConfig(),
            ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
            ...migrationConfig,
            ...commonProperties,
        })
    }

    const database = system.getOrThrow(AppSystemProp.POSTGRES_DATABASE)
    const host = system.getOrThrow(AppSystemProp.POSTGRES_HOST)
    const password = system.getOrThrow(AppSystemProp.POSTGRES_PASSWORD)
    const serializedPort = system.getOrThrow(AppSystemProp.POSTGRES_PORT)
    const port = Number.parseInt(serializedPort, 10)
    const idleTimeoutMillis = system.getNumberOrThrow(AppSystemProp.POSTGRES_IDLE_TIMEOUT_MS)
    const username = system.getOrThrow(AppSystemProp.POSTGRES_USERNAME)

    return new DataSource({
        type: 'postgres',
        host,
        port,
        username,
        password,
        database,
        ssl: getSslConfig(),
        ...spreadIfDefined('poolSize', system.get(AppSystemProp.POSTGRES_POOL_SIZE)),
        ...commonProperties,
        ...migrationConfig,
        extra: {
            idleTimeoutMillis,
        },
    })
}

type MigrationConfig = {
    migrationsRun?: boolean
    migrationsTransactionMode?: 'all' | 'none' | 'each'
    migrations?: (new () => Migration)[]
    synchronize: false
}
