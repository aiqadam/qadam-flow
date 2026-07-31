import { isNil } from '@aiqadam/shared'
import {
    DataSource,
    EntitySchema,
} from 'typeorm'
import { AIProviderEntity } from '../ai/ai-provider-entity'
import { AlertEntity } from '../alerts/alerts-entity'
import { PlatformAnalyticsReportEntity } from '../analytics/platform-analytics-report.entity'
import { ApiKeyEntity } from '../api-keys/api-key.entity'
import { AppConnectionEntity } from '../app-connection/app-connection.entity'
import { OtpEntity } from '../authentication/otp/otp-entity'
import { UserIdentityEntity } from '../authentication/user-identity/user-identity-entity'
import { ChatConversationEntity } from '../chat/chat-conversation-entity'
import { FileEntity } from '../file/file.entity'
import { FlagEntity } from '../flags/flag.entity'
import { FlowEntity } from '../flows/flow/flow.entity'
import { FlowRunEntity } from '../flows/flow-run/flow-run-entity'
import { WaitpointEntity } from '../flows/flow-run/waitpoint/waitpoint-entity'
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
import { QadamTagEntity } from '../qadams/tags/qadams/qadam-tag.entity'
import { TagEntity } from '../qadams/tags/tag-entity'
import { StoreEntryEntity } from '../store-entry/store-entry-entity'
import { FieldEntity } from '../tables/field/field.entity'
import { CellEntity } from '../tables/record/cell.entity'
import { RecordEntity } from '../tables/record/record.entity'
import { TableWebhookEntity } from '../tables/table/table-webhook.entity'
import { TableEntity } from '../tables/table/table.entity'
import { TemplateEntity } from '../template/template.entity'
import { AppEventRoutingEntity } from '../trigger/app-event-routing/app-event-routing.entity'
import { TriggerEventEntity } from '../trigger/trigger-events/trigger-event.entity'
import { TriggerSourceEntity } from '../trigger/trigger-source/trigger-source-entity'
import { UserBadgeEntity } from '../user/badges/badge-entity'
import { UserEntity } from '../user/user-entity'
import { UserInvitationEntity } from '../user-invitations/user-invitation.entity'
import { VariableEntity } from '../variable/variable.entity'
import { DatabaseType } from './database-type'
import { createPostgresDataSource } from './postgres-connection'

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
        TemplateEntity,
        PlatformAnalyticsReportEntity,
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

const createDataSource = (): DataSource => {
    if (!isSupportedDatabaseType(databaseType)) {
        throw new Error(`Unsupported AP_DB_TYPE "${databaseType}". PGLite support has been removed — POSTGRES is the only supported database type. Set AP_DB_TYPE=POSTGRES, or remove the variable to use the default. There is no automated migration from a PGLite data directory to PostgreSQL; see https://flow.aiqadam.org/docs/install/configuration/breaking-changes for details.`)
    }
    return createPostgresDataSource()
}

export const databaseConnection = (): DataSource => {
    const existing = getPersistedConnection()
    if (!isNil(existing)) {
        return existing
    }
    const ds = createDataSource()
    setPersistedConnection(ds)
    return ds
}

export function resetDatabaseConnection(): void {
    setPersistedConnection(null)
}
