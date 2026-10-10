import { isNil, isObject, tryCatch } from '@aiqadam/shared'
import {
    DataSource,
    EntitySchema,
} from 'typeorm'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { AlertEntity } from '../alerts/alerts-entity'
import { PlatformAnalyticsReportEntity } from '../analytics/platform-analytics-report.entity'
import { ApiKeyEntity } from '../api-keys/api-key.entity'
import { AppConnectionEntity } from '../app-connection/app-connection.entity'
import { UserFederatedIdentityEntity } from '../authentication/federated-identity/user-federated-identity-entity'
import { PlatformLdapConfigEntity } from '../authentication/ldap/ldap-config-entity'
import { OtpEntity } from '../authentication/otp/otp-entity'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { ChatConversationEntity } from '../chat/chat-conversation-entity'
import { FileEntity } from '../file/file.entity'
import { FlagEntity } from '../flags/flag.entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { WaitpointEntity } from '../flows/flow-run/waitpoint/waitpoint-entity'
import { WaitpointSlotEntity } from '../flows/flow-run/waitpoint/waitpoint-slot-entity'
import { FlowVersionEntity } from '../flows/flow-version/flow-version-entity'
import { FolderEntity } from '../flows/folder/folder.entity'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { KnowledgeBaseChunkEntity } from '../knowledge-base/knowledge-base-chunk.entity'
import { KnowledgeBaseFileEntity } from '../knowledge-base/knowledge-base-file.entity'
import { McpServerEntity } from '../mcp/mcp-entity'
import { McpOAuthClientEntity } from '../mcp/oauth/client/mcp-oauth-client.entity'
import { McpOAuthAuthorizationCodeEntity } from '../mcp/oauth/code/mcp-oauth-code.entity'
import { McpOAuthTokenEntity } from '../mcp/oauth/token/mcp-oauth-token.entity'
import { PlatformEntity } from '../platform/platform.entity'
import { ConcurrencyPoolEntity } from '../project/concurrency-pool-entity'
import { ProjectEntity } from '../project/project-entity'
import { ProjectMemberEntity } from '../project/project-member.entity'
import { ProjectRoleEntity } from '../project/project-role.entity'
import { QadamMetadataEntity } from '../qadams/metadata/qadam-metadata-entity'
import { QadamPinMoveEntity } from '../qadams/pin-moves/qadam-pin-move.entity'
import { QadamTagEntity } from '../qadams/tags/qadams/qadam-tag.entity'
import { TagEntity } from '../qadams/tags/tag-entity'
import { StoreEntryEntity } from '../store-entry/store-entry-entity'
import { FieldEntity } from '../tables/field/field.entity'
import { CellEntity } from '../tables/record/cell.entity'
import { RecordEntity } from '../tables/record/record.entity'
import { TableWebhookEntity } from '../tables/table/table-webhook.entity'
import { TableEntity } from '../tables/table/table.entity'
import { TemplateEntity } from '../template/template.entity'
import { TranslationEntity } from '../translation/translation.entity'
import { AppEventRoutingEntity } from '../trigger/app-event-routing/app-event-routing.entity'
import { TriggerEventEntity } from '../trigger/trigger-events/trigger-event.entity'
import { TriggerSourceEntity } from '../trigger/trigger-source/trigger-source-entity'
import { UserBadgeEntity } from '../user/badges/badge-entity'
import { UserEntity } from '../user/user-entity'
import { UserInvitationEntity } from '../user-invitations/user-invitation.entity'
import { VariableEntity } from '../variable/variable.entity'
import { DatabaseType } from './database-type'
import { createPostgresDataSource, DataSourceAccess } from './postgres-connection'

const databaseType = system.get(AppSystemProp.DB_TYPE)?.trim()

function getEntities(): EntitySchema<unknown>[] {
    return [
        TriggerEventEntity,
        AppEventRoutingEntity,
        FileEntity,
        FlagEntity,
        FlowEntity,
        FlowVersionEntity,
        FlowRunEntity,
        ProjectEntity,
        ConcurrencyPoolEntity,
        ProjectRoleEntity,
        ProjectMemberEntity,
        StoreEntryEntity,
        UserEntity,
        OtpEntity,
        AlertEntity,
        ApiKeyEntity,
        AppConnectionEntity,
        VariableEntity,
        TranslationEntity,
        FolderEntity,
        QadamMetadataEntity,
        PlatformEntity,
        TagEntity,
        QadamTagEntity,
        UserInvitationEntity,
        AIProviderEntity,
        ChatConversationEntity,
        TableEntity,
        FieldEntity,
        RecordEntity,
        CellEntity,
        TableWebhookEntity,
        UserIdentityEntity,
        McpServerEntity,
        McpOAuthClientEntity,
        McpOAuthAuthorizationCodeEntity,
        McpOAuthTokenEntity,
        KnowledgeBaseFileEntity,
        KnowledgeBaseChunkEntity,
        TriggerSourceEntity,
        UserBadgeEntity,
        WaitpointEntity,
        WaitpointSlotEntity,
        TemplateEntity,
        PlatformAnalyticsReportEntity,
        PlatformLdapConfigEntity,
        UserFederatedIdentityEntity,
        QadamPinMoveEntity,
    ]
}

export const commonProperties = {
    subscribers: [],
    entities: getEntities(),
}

const DB_GLOBAL_KEY = '__AP_DB_CONNECTION__'

function getPersistedConnection(): DataSource | null {
    return ((globalThis as Record<string, unknown>)[DB_GLOBAL_KEY] as DataSource) ?? null
}

function setPersistedConnection(ds: DataSource | null): void {
    (globalThis as Record<string, unknown>)[DB_GLOBAL_KEY] = ds
}

// An empty/whitespace-only value (a blank `.env` line, or a compose override like
// `- AP_DB_TYPE=${AP_DB_TYPE}` with nothing exported) is treated as absent, matching the
// historical default rather than refusing to start over a value nobody set. Casing is not
// enforced either — POSTGRES is the only value left, so rejecting "postgres" or "Postgres"
// would trade a real outage for policing a convention that was never documented anywhere
// an operator would read it.
function isSupportedDatabaseType(value: string | undefined): boolean {
    return isNil(value) || value === '' || value.toUpperCase() === DatabaseType.POSTGRES
}

const createDataSource = ({ access }: { access: DataSourceAccess }): DataSource => {
    if (!isSupportedDatabaseType(databaseType)) {
        throw new Error(`Unsupported AP_DB_TYPE "${databaseType}". PGLite support has been removed — POSTGRES is the only supported database type. Set AP_DB_TYPE=POSTGRES, or remove the variable to use the default. There is no automated migration from a PGLite data directory to PostgreSQL; see https://flow.aiqadam.org/docs/install/configuration/breaking-changes for details.`)
    }
    return createPostgresDataSource({ access })
}

export const databaseConnection = (): DataSource => {
    const existing = getPersistedConnection()
    if (!isNil(existing)) {
        return existing
    }
    const ds = createDataSource({ access: 'read-write' })
    setPersistedConnection(ds)
    return ds
}

// For an operator command that reports on a database this image may not have migrated yet — the
// framework census `doctor` (ADR-0002) runs from a new image against the live database before the
// upgrade. The application's connection would migrate that database on `initialize()`; this one
// never migrates and Postgres refuses its writes. It becomes the process's connection so the
// repositories read through it, and it refuses to replace a connection that already exists.
//
// Read-only rests on the startup option `default_transaction_read_only=on`, which can be lost on
// the way: node-postgres lets a `POSTGRES_URL` carrying its own `?options=` override it, and
// PgBouncer with `ignore_startup_parameters=options` drops it. So the connection asks Postgres
// after connecting and fails closed — it is destroyed and the call throws — unless the session
// reports `on`. A per-session `SET` is no substitute: under transaction pooling it would leak to
// other clients' sessions.
export async function openReadOnlyDatabaseConnection(): Promise<DataSource> {
    if (!isNil(getPersistedConnection())) {
        throw new Error('A database connection already exists in this process; a read-only connection must be the first and only one.')
    }
    const ds = createDataSource({ access: 'read-only' })
    setPersistedConnection(ds)
    const { error } = await tryCatch(async () => {
        await ds.initialize()
        await assertSessionIsReadOnly(ds)
    })
    if (isNil(error)) {
        return ds
    }
    // Whatever the teardown does, the refused connection never stays the process's connection,
    // and the caller sees why it was refused, not a failure of the cleanup.
    if (ds.isInitialized) {
        const { error: destroyError } = await tryCatch(() => ds.destroy())
        if (!isNil(destroyError)) {
            system.globalLogger().warn({ err: destroyError }, '[openReadOnlyDatabaseConnection] Closing the refused read-only connection failed')
        }
    }
    setPersistedConnection(null)
    throw error
}

// `replacement` puts back a connection a test set aside (the doctor's test swaps the shared one out).
export function resetDatabaseConnection({ replacement = null }: { replacement?: DataSource | null } = {}): void {
    setPersistedConnection(replacement)
}

async function assertSessionIsReadOnly(ds: DataSource): Promise<void> {
    const rows: unknown = await ds.query('SHOW default_transaction_read_only')
    const setting = Array.isArray(rows) && isObject(rows[0]) ? rows[0].default_transaction_read_only : undefined
    if (setting !== 'on') {
        throw new Error(`Refusing to run: the read-only database session reports default_transaction_read_only=${String(setting)}, not "on". A POSTGRES_URL with its own "options" parameter, or a pooler that drops startup options (PgBouncer's ignore_startup_parameters), removes the read-only guarantee. Connect directly to Postgres, or remove the "options" parameter from the URL.`)
    }
}
