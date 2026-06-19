import { QueryRunner } from 'typeorm'
import { Migration } from '../../migration'

export class BaselineQadamFlow1750000000000 implements Migration {
    name = 'BaselineQadamFlow1750000000000'
    transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        // --- Base / referenced tables (no inbound FKs at create time) ---

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "user_identity" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "email" character varying NOT NULL,
                "password" character varying NOT NULL,
                "trackEvents" boolean,
                "newsLetter" boolean,
                "verified" boolean NOT NULL DEFAULT false,
                "firstName" character varying NOT NULL,
                "lastName" character varying NOT NULL,
                "tokenVersion" character varying,
                "provider" character varying NOT NULL,
                "imageUrl" character varying,
                "lastLoggedInPlatformId" character varying(21),
                CONSTRAINT "pk_user_identity" PRIMARY KEY ("id"),
                CONSTRAINT "uq_user_identity_email" UNIQUE ("email")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_identity_email" ON "user_identity" ("email")')

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "user" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "status" character varying NOT NULL,
                "platformRole" character varying NOT NULL,
                "identityId" character varying NOT NULL,
                "externalId" character varying,
                "platformId" character varying,
                "lastActiveDate" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "pk_user" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_platform_id_email" ON "user" ("platformId", "identityId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_platform_id_external_id" ON "user" ("platformId", "externalId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_user_identity_id" ON "user" ("identityId")')
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "user" ADD CONSTRAINT "fk_user_identity_id"
                FOREIGN KEY ("identityId") REFERENCES "user_identity"("id");
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "platform" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "ownerId" character varying(21) NOT NULL,
                "name" character varying NOT NULL,
                "primaryColor" character varying NOT NULL,
                "logoIconUrl" character varying NOT NULL,
                "fullLogoUrl" character varying NOT NULL,
                "favIconUrl" character varying NOT NULL,
                "googleAuthEnabled" boolean NOT NULL DEFAULT true,
                "filteredQadamNames" character varying array NOT NULL,
                "filteredQadamBehavior" character varying NOT NULL,
                "allowedAuthDomains" character varying array,
                "allowedEmbedOrigins" character varying array NOT NULL DEFAULT ARRAY[]::character varying[],
                "ssoDomain" character varying,
                "ssoDomainVerification" jsonb,
                "enforceAllowedAuthDomains" boolean NOT NULL,
                "emailAuthEnabled" boolean NOT NULL,
                "federatedAuthProviders" jsonb,
                "pinnedQadams" character varying array NOT NULL,
                CONSTRAINT "pk_platform" PRIMARY KEY ("id"),
                CONSTRAINT "fk_platform_user" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_sso_domain" ON "platform" ("ssoDomain") WHERE "ssoDomain" IS NOT NULL')

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "concurrency_pool" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "key" character varying NOT NULL,
                "maxConcurrentJobs" integer NOT NULL,
                CONSTRAINT "pk_concurrency_pool" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_concurrency_pool_platform_key" ON "concurrency_pool" ("platformId", "key")')

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "project" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "deleted" TIMESTAMP WITH TIME ZONE,
                "ownerId" character varying(21) NOT NULL,
                "displayName" character varying NOT NULL,
                "type" character varying NOT NULL,
                "platformId" character varying(21) NOT NULL,
                "externalId" character varying,
                "maxConcurrentJobs" integer,
                "icon" jsonb NOT NULL,
                "releasesEnabled" boolean NOT NULL DEFAULT false,
                "metadata" jsonb,
                "poolId" character varying(21),
                CONSTRAINT "pk_project" PRIMARY KEY ("id"),
                CONSTRAINT "fk_project_owner_id" FOREIGN KEY ("ownerId") REFERENCES "user"("id"),
                CONSTRAINT "fk_project_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
                CONSTRAINT "fk_project_pool_id" FOREIGN KEY ("poolId") REFERENCES "concurrency_pool"("id") ON DELETE SET NULL
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_project_owner_id" ON "project" ("ownerId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_platform_id_external_id" ON "project" ("platformId", "externalId") WHERE deleted IS NULL')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_project_platform_id" ON "project" ("platformId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_project_pool_id" ON "project" ("poolId")')

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "project_role" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "permissions" character varying array NOT NULL,
                "platformId" character varying,
                "type" character varying NOT NULL,
                CONSTRAINT "pk_project_role" PRIMARY KEY ("id")
            )
        `)

        // --- File (depends on project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "file" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21),
                "platformId" character varying(21),
                "data" bytea,
                "location" character varying NOT NULL,
                "fileName" character varying,
                "size" integer,
                "metadata" jsonb,
                "s3Key" character varying,
                "type" character varying NOT NULL DEFAULT 'UNKNOWN',
                "compression" character varying NOT NULL DEFAULT 'NONE',
                CONSTRAINT "pk_file" PRIMARY KEY ("id"),
                CONSTRAINT "fk_file_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_file_project_id" ON "file" ("projectId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_file_type_created_desc" ON "file" ("type", "created")')

        // --- Folder (depends on project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "folder" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "displayName" character varying NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "displayOrder" integer NOT NULL DEFAULT 0,
                CONSTRAINT "pk_folder" PRIMARY KEY ("id"),
                CONSTRAINT "fk_folder_project" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_folder_project_id_display_name" ON "folder" ("projectId", "displayName")')

        // --- Flow (depends on user, project, folder; published flow_version FK added later) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "flow" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "folderId" character varying(21),
                "status" character varying NOT NULL DEFAULT 'DISABLED',
                "externalId" character varying NOT NULL,
                "publishedVersionId" character varying(21),
                "metadata" jsonb,
                "operationStatus" character varying NOT NULL DEFAULT 'NONE',
                "timeSavedPerRun" integer,
                "ownerId" character varying,
                "templateId" character varying,
                "createdBy" jsonb,
                CONSTRAINT "pk_flow" PRIMARY KEY ("id"),
                CONSTRAINT "uq_flow_published_version_id" UNIQUE ("publishedVersionId"),
                CONSTRAINT "fk_flow_owner_id" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL,
                CONSTRAINT "fk_flow_folder_id" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE SET NULL,
                CONSTRAINT "fk_flow_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_project_id" ON "flow" ("projectId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_owner_id" ON "flow" ("ownerId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_folder_id" ON "flow" ("folderId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_project_id_status" ON "flow" ("projectId", "status")')

        // --- Flow Version (depends on flow, user) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "flow_version" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "flowId" character varying(21) NOT NULL,
                "displayName" character varying NOT NULL,
                "schemaVersion" character varying,
                "trigger" jsonb,
                "connectionIds" character varying array NOT NULL,
                "agentIds" character varying array NOT NULL,
                "updatedBy" character varying,
                "valid" boolean NOT NULL,
                "state" character varying NOT NULL,
                "backupFiles" jsonb,
                "notes" jsonb NOT NULL,
                CONSTRAINT "pk_flow_version" PRIMARY KEY ("id"),
                CONSTRAINT "fk_updated_by_user_flow" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE SET NULL,
                CONSTRAINT "fk_flow_version_flow" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_version_flow_id_created_desc" ON "flow_version" ("flowId", "created")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_version_schema_version" ON "flow_version" ("schemaVersion")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_flow_version_updated_by" ON "flow_version" ("updatedBy")')

        // FK from flow.publishedVersionId -> flow_version.id (added after flow_version exists)
        await queryRunner.query(`
            DO $$ BEGIN
                ALTER TABLE "flow"
                ADD CONSTRAINT "fk_flow_published_version"
                FOREIGN KEY ("publishedVersionId") REFERENCES "flow_version"("id") ON DELETE RESTRICT;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$
        `)

        // --- Flow Run (depends on project, flow, flow_version, file, user) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "flow_run" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "flowId" character varying(21) NOT NULL,
                "flowVersionId" character varying(21) NOT NULL,
                "environment" character varying,
                "logsFileId" character varying(21),
                "parentRunId" character varying(21),
                "failParentOnFailure" boolean NOT NULL DEFAULT true,
                "status" character varying NOT NULL,
                "tags" character varying array,
                "startTime" TIMESTAMP WITH TIME ZONE,
                "triggeredBy" character varying,
                "finishTime" TIMESTAMP WITH TIME ZONE,
                "failedStep" jsonb,
                "archivedAt" character varying DEFAULT NULL,
                "stepNameToTest" character varying,
                "stepsCount" integer NOT NULL DEFAULT 0,
                "pauseMetadata" jsonb,
                CONSTRAINT "pk_flow_run" PRIMARY KEY ("id"),
                CONSTRAINT "fk_flow_run_triggered_by_user_id" FOREIGN KEY ("triggeredBy") REFERENCES "user"("id") ON DELETE SET NULL,
                CONSTRAINT "fk_flow_run_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_flow_run_flow_id" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_flow_run_flow_version_id" FOREIGN KEY ("flowVersionId") REFERENCES "flow_version"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_flow_run_logs_file_id" FOREIGN KEY ("logsFileId") REFERENCES "file"("id") ON DELETE SET NULL
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_project_id_environment_flow_id_status_created_archived_" ON "flow_run" ("projectId", "environment", "flowId", "status", "created", "archivedAt")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_project_id_environment_status_created_archived_at" ON "flow_run" ("projectId", "environment", "status", "created", "archivedAt")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_project_id_environment_created_archived_at" ON "flow_run" ("projectId", "environment", "created", "archivedAt")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_project_id_environment_created_status_archived_at" ON "flow_run" ("projectId", "environment", "created", "archivedAt", "status")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_project_id_environment_flow_id_created_archived_at" ON "flow_run" ("projectId", "environment", "flowId", "created", "archivedAt")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_flow_id" ON "flow_run" ("flowId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_logs_file_id" ON "flow_run" ("logsFileId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_parent_run_id" ON "flow_run" ("parentRunId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_flow_version_id" ON "flow_run" ("flowVersionId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_run_triggered_by" ON "flow_run" ("triggeredBy")')

        // --- Waitpoint (depends on project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "waitpoint" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "flowRunId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "type" character varying NOT NULL,
                "status" character varying NOT NULL,
                "resumeDateTime" TIMESTAMP WITH TIME ZONE,
                "responseToSend" jsonb,
                "workerHandlerId" character varying,
                "httpRequestId" character varying,
                "version" character varying NOT NULL DEFAULT 'V0',
                "stepName" character varying NOT NULL DEFAULT '',
                "resumePayload" jsonb,
                CONSTRAINT "pk_waitpoint" PRIMARY KEY ("id"),
                CONSTRAINT "fk_waitpoint_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_waitpoint_flow_run_id_step_name" ON "waitpoint" ("flowRunId", "stepName")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_waitpoint_project_id" ON "waitpoint" ("projectId")')

        // --- App Connection (depends on user) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "app_connection" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "displayName" character varying NOT NULL,
                "externalId" character varying NOT NULL,
                "type" character varying NOT NULL,
                "status" character varying NOT NULL DEFAULT 'ACTIVE',
                "platformId" character varying NOT NULL,
                "qadamName" character varying NOT NULL,
                "ownerId" character varying,
                "projectIds" character varying array NOT NULL,
                "scope" character varying NOT NULL,
                "value" jsonb NOT NULL,
                "metadata" jsonb,
                "qadamVersion" character varying NOT NULL,
                "preSelectForNewProjects" boolean NOT NULL DEFAULT false,
                CONSTRAINT "pk_app_connection" PRIMARY KEY ("id"),
                CONSTRAINT "fk_app_connection_owner_id" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_app_connection_platform_id_and_external_id" ON "app_connection" ("platformId", "externalId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_app_connection_owner_id" ON "app_connection" ("ownerId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_app_connection_project_ids_gin" ON "app_connection" USING GIN ("projectIds")')

        // --- Variable (depends on user) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "variable" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "projectId" character varying NOT NULL,
                "platformId" character varying NOT NULL,
                "ownerId" character varying,
                "value" jsonb NOT NULL,
                "metadata" jsonb,
                CONSTRAINT "pk_variable" PRIMARY KEY ("id"),
                CONSTRAINT "fk_variable_owner_id" FOREIGN KEY ("ownerId") REFERENCES "user"("id") ON DELETE SET NULL
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_variable_project_id_and_name" ON "variable" ("projectId", "name")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_variable_owner_id" ON "variable" ("ownerId")')

        // --- Custom collation for natural version sorting ---
        // ICU not available on pglite (WASM PG); swallow that too so dev works.
        await queryRunner.query(`
            DO $$ BEGIN
                CREATE COLLATION "en_natural" (LOCALE = 'en-US-u-kn-true', PROVIDER = 'icu');
            EXCEPTION
                WHEN duplicate_object THEN NULL;
                WHEN feature_not_supported THEN NULL;
            END $$
        `)

        // --- Qadam Metadata (depends on file) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "qadam_metadata" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "authors" character varying array NOT NULL,
                "displayName" character varying NOT NULL,
                "logoUrl" character varying NOT NULL,
                "projectUsage" integer NOT NULL DEFAULT 0,
                "description" character varying,
                "platformId" character varying,
                "version" character varying NOT NULL,
                "minimumSupportedRelease" character varying NOT NULL,
                "maximumSupportedRelease" character varying NOT NULL,
                "auth" json,
                "actions" json NOT NULL,
                "triggers" json NOT NULL,
                "qadamType" character varying NOT NULL,
                "categories" character varying array,
                "packageType" character varying NOT NULL,
                "archiveId" character varying(21),
                "i18n" json,
                CONSTRAINT "pk_qadam_metadata" PRIMARY KEY ("id"),
                CONSTRAINT "fk_qadam_metadata_file" FOREIGN KEY ("archiveId") REFERENCES "file"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_qadam_metadata_name_platform_id_version" ON "qadam_metadata" ("name", "version", "platformId")')

        // --- Tag (depends on platform) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "tag" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying NOT NULL,
                "name" character varying NOT NULL,
                CONSTRAINT "pk_tag" PRIMARY KEY ("id"),
                CONSTRAINT "uq_tag_platform_id_name" UNIQUE ("platformId", "name"),
                CONSTRAINT "fk_tag_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id")
            )
        `)

        // --- Qadam Tag (depends on tag, platform) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "qadam_tag" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying NOT NULL,
                "qadamName" character varying NOT NULL,
                "tagId" character varying NOT NULL,
                CONSTRAINT "pk_qadam_tag" PRIMARY KEY ("id"),
                CONSTRAINT "uq_qadam_tag_tag_id_qadam_name" UNIQUE ("tagId", "qadamName"),
                CONSTRAINT "fk_qadam_tag_tag_id" FOREIGN KEY ("tagId") REFERENCES "tag"("id"),
                CONSTRAINT "fk_qadam_tag_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id")
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "tag_platformId" ON "qadam_tag" ("platformId")')

        // --- User Invitation (depends on project, project_role) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "user_invitation" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying NOT NULL,
                "type" character varying NOT NULL,
                "platformRole" character varying,
                "email" character varying NOT NULL,
                "projectId" character varying,
                "status" character varying NOT NULL,
                "projectRoleId" character varying,
                CONSTRAINT "pk_user_invitation" PRIMARY KEY ("id"),
                CONSTRAINT "fk_user_invitation_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_user_invitation_project_role_id" FOREIGN KEY ("projectRoleId") REFERENCES "project_role"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_invitation_email_platform_project" ON "user_invitation" ("email", "platformId", "projectId")')

        // --- AI Provider (depends on platform) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "ai_provider" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "config" json NOT NULL,
                "auth" json NOT NULL,
                "provider" character varying NOT NULL,
                "platformId" character varying(21) NOT NULL,
                "displayName" character varying NOT NULL,
                "enabledForChat" boolean NOT NULL DEFAULT false,
                CONSTRAINT "pk_ai_provider" PRIMARY KEY ("id"),
                CONSTRAINT "fk_ai_provider_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_ai_provider_platform_id_provider" ON "ai_provider" ("platformId", "provider")')

        // --- Table (depends on project, folder) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "table" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "folderId" character varying(21),
                "externalId" character varying NOT NULL,
                "trigger" character varying,
                "status" character varying,
                "projectId" character varying(21) NOT NULL,
                CONSTRAINT "pk_table" PRIMARY KEY ("id"),
                CONSTRAINT "fk_table_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_table_folder_id" FOREIGN KEY ("folderId") REFERENCES "folder"("id") ON DELETE SET NULL
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_table_project_id_name" ON "table" ("projectId", "name")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_table_folder_id" ON "table" ("folderId")')

        // --- Field (depends on table, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "field" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "type" character varying NOT NULL,
                "tableId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "externalId" character varying NOT NULL,
                "data" jsonb,
                CONSTRAINT "pk_field" PRIMARY KEY ("id"),
                CONSTRAINT "fk_field_table_id" FOREIGN KEY ("tableId") REFERENCES "table"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_field_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_field_project_id_table_id_name" ON "field" ("projectId", "tableId", "name")')

        // --- Record (depends on table, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "record" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "tableId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                CONSTRAINT "pk_record" PRIMARY KEY ("id"),
                CONSTRAINT "fk_record_table_id" FOREIGN KEY ("tableId") REFERENCES "table"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_record_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_record_project_id_table_id" ON "record" ("projectId", "tableId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_record_table_id_project_id_record_id" ON "record" ("tableId", "projectId", "id")')

        // --- Cell (depends on record, field, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "cell" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "recordId" character varying(21) NOT NULL,
                "fieldId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "value" character varying NOT NULL,
                CONSTRAINT "pk_cell" PRIMARY KEY ("id"),
                CONSTRAINT "fk_cell_record_id" FOREIGN KEY ("recordId") REFERENCES "record"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_cell_field_id" FOREIGN KEY ("fieldId") REFERENCES "field"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_cell_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_cell_project_id_field_id_record_id_unique" ON "cell" ("projectId", "fieldId", "recordId")')

        // --- Table Webhook (depends on project, table, flow) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "table_webhook" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "tableId" character varying(21) NOT NULL,
                "events" character varying array NOT NULL,
                "flowId" character varying(21) NOT NULL,
                CONSTRAINT "pk_table_webhook" PRIMARY KEY ("id"),
                CONSTRAINT "fk_table_webhook_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_table_webhook_table_id" FOREIGN KEY ("tableId") REFERENCES "table"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_table_webhook_flow_id" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_table_webhook_flow_id" ON "table_webhook" ("flowId")')

        // --- MCP Server (depends on platform, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mcp_server" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21),
                "projectId" character varying(21),
                "type" character varying NOT NULL,
                "token" character varying NOT NULL,
                "disabledTools" jsonb,
                CONSTRAINT "pk_mcp_server" PRIMARY KEY ("id"),
                CONSTRAINT "fk_mcp_server_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_mcp_server_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "mcp_server_project_id" ON "mcp_server" ("projectId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_server_token" ON "mcp_server" ("token")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_server_platform_id" ON "mcp_server" ("platformId")')

        // --- MCP OAuth Client ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mcp_oauth_client" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "clientId" character varying(64) NOT NULL,
                "clientSecret" character varying(128),
                "clientSecretExpiresAt" bigint NOT NULL DEFAULT 0,
                "clientIdIssuedAt" bigint NOT NULL,
                "redirectUris" character varying array NOT NULL,
                "clientName" character varying(255),
                "grantTypes" character varying array NOT NULL,
                "tokenEndpointAuthMethod" character varying(64) NOT NULL DEFAULT 'none',
                CONSTRAINT "pk_mcp_oauth_client" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_oauth_client_client_id" ON "mcp_oauth_client" ("clientId")')

        // --- MCP OAuth Authorization Code ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mcp_oauth_authorization_code" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "code" character varying(128) NOT NULL,
                "clientId" character varying(64) NOT NULL,
                "userId" character varying(21) NOT NULL,
                "projectId" character varying(21),
                "platformId" character varying(21) NOT NULL,
                "redirectUri" character varying(2048) NOT NULL,
                "codeChallenge" character varying(256) NOT NULL,
                "codeChallengeMethod" character varying(8) NOT NULL DEFAULT 'S256',
                "scopes" character varying array,
                "state" character varying(512),
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "used" boolean NOT NULL DEFAULT false,
                CONSTRAINT "pk_mcp_oauth_authorization_code" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_oauth_code" ON "mcp_oauth_authorization_code" ("code")')

        // --- MCP OAuth Token ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "mcp_oauth_token" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "refreshToken" character varying(128) NOT NULL,
                "clientId" character varying(64) NOT NULL,
                "userId" character varying(21) NOT NULL,
                "projectId" character varying(21),
                "platformId" character varying(21) NOT NULL,
                "scopes" character varying array,
                "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
                "revoked" boolean NOT NULL DEFAULT false,
                CONSTRAINT "pk_mcp_oauth_token" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_mcp_oauth_token_refresh" ON "mcp_oauth_token" ("refreshToken")')

        // --- Knowledge Base File (depends on project, file) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "knowledge_base_file" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "fileId" character varying(21) NOT NULL,
                "displayName" character varying NOT NULL,
                CONSTRAINT "pk_knowledge_base_file" PRIMARY KEY ("id"),
                CONSTRAINT "fk_kb_file_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_kb_file_file_id" FOREIGN KEY ("fileId") REFERENCES "file"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_kb_file_project_id" ON "knowledge_base_file" ("projectId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_kb_file_file_id" ON "knowledge_base_file" ("fileId")')

        // --- Knowledge Base Chunk (depends on knowledge_base_file). Uses pgvector. ---
        await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector')
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "knowledge_base_chunk" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "projectId" character varying(21) NOT NULL,
                "knowledgeBaseFileId" character varying(21) NOT NULL,
                "content" text NOT NULL,
                "chunkIndex" integer NOT NULL,
                "embedding" vector(768),
                "metadata" jsonb,
                CONSTRAINT "pk_knowledge_base_chunk" PRIMARY KEY ("id"),
                CONSTRAINT "fk_kb_chunk_kb_file_id" FOREIGN KEY ("knowledgeBaseFileId") REFERENCES "knowledge_base_file"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_kb_chunk_project_file" ON "knowledge_base_chunk" ("projectId", "knowledgeBaseFileId")')

        // --- Trigger Event (depends on project, file, flow) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "trigger_event" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "flowId" character varying(21) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "sourceName" character varying NOT NULL,
                "fileId" character varying NOT NULL,
                CONSTRAINT "pk_trigger_event" PRIMARY KEY ("id"),
                CONSTRAINT "fk_trigger_event_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_trigger_event_file_id" FOREIGN KEY ("fileId") REFERENCES "file"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_trigger_event_flow_id" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_trigger_event_project_id_flow_id" ON "trigger_event" ("projectId", "flowId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_trigger_event_flow_id" ON "trigger_event" ("flowId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_trigger_event_file_id" ON "trigger_event" ("fileId")')

        // --- App Event Routing ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "app_event_routing" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "appName" character varying NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "flowId" character varying(21) NOT NULL,
                "identifierValue" character varying NOT NULL,
                "event" character varying NOT NULL,
                CONSTRAINT "pk_app_event_routing" PRIMARY KEY ("id")
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_app_event_routing_flow_id" ON "app_event_routing" ("flowId")')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_app_event_flow_id_project_id_appName_identifier_value_event" ON "app_event_routing" ("appName", "projectId", "flowId", "identifierValue", "event")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_app_event_appName_identifier_event" ON "app_event_routing" ("appName", "identifierValue", "event")')

        // --- Trigger Source (depends on flow, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "trigger_source" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "deleted" TIMESTAMP WITH TIME ZONE,
                "flowId" character varying NOT NULL,
                "flowVersionId" character varying NOT NULL,
                "triggerName" character varying NOT NULL,
                "projectId" character varying NOT NULL,
                "type" character varying NOT NULL,
                "schedule" jsonb,
                "qadamName" character varying NOT NULL,
                "qadamVersion" character varying NOT NULL,
                "simulate" boolean NOT NULL,
                CONSTRAINT "pk_trigger_source" PRIMARY KEY ("id"),
                CONSTRAINT "fk_trigger_source_flow_id" FOREIGN KEY ("flowId") REFERENCES "flow"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_trigger_source_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_trigger_project_id_flow_id_simulate" ON "trigger_source" ("projectId", "flowId", "simulate") WHERE deleted IS NULL')
        await queryRunner.query('CREATE UNIQUE INDEX IF NOT EXISTS "idx_trigger_flow_id_simulate" ON "trigger_source" ("flowId", "simulate") WHERE deleted IS NULL')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_trigger_flow_id" ON "trigger_source" ("flowId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_trigger_project_id" ON "trigger_source" ("projectId")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_trigger_flow_version_id" ON "trigger_source" ("flowVersionId") WHERE deleted IS NULL')

        // --- User Badge (depends on user) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "user_badge" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "userId" character varying(21) NOT NULL,
                CONSTRAINT "pk_user_badge" PRIMARY KEY ("id"),
                CONSTRAINT "idx_user_badge_user_id_name" UNIQUE ("userId", "name"),
                CONSTRAINT "fk_user_badge_user_id" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_user_badge_user_id" ON "user_badge" ("userId")')

        // --- Template (depends on platform) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "template" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "name" character varying NOT NULL,
                "summary" character varying NOT NULL,
                "description" character varying NOT NULL,
                "type" character varying NOT NULL,
                "platformId" character varying,
                "status" character varying NOT NULL,
                "flows" jsonb,
                "tables" jsonb,
                "tags" jsonb NOT NULL,
                "blogUrl" character varying,
                "metadata" jsonb,
                "author" character varying NOT NULL,
                "categories" character varying array NOT NULL,
                "qadams" character varying array NOT NULL,
                CONSTRAINT "pk_template" PRIMARY KEY ("id"),
                CONSTRAINT "fk_template_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_template_qadams" ON "template" ("qadams")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_template_categories" ON "template" ("categories")')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_template_platform_id" ON "template" ("platformId")')

        // --- Platform Analytics Report (depends on platform) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "platform_analytics_report" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying NOT NULL,
                "outdated" boolean NOT NULL,
                "cachedAt" TIMESTAMP NOT NULL,
                "runs" jsonb NOT NULL,
                "flows" jsonb NOT NULL,
                "users" jsonb NOT NULL,
                CONSTRAINT "pk_platform_analytics_report" PRIMARY KEY ("id"),
                CONSTRAINT "fk_platform_analytics_report_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_platform_analytics_report_platform_id" ON "platform_analytics_report" ("platformId")')

        // --- Event Destination (depends on platform, project) ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "event_destination" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "platformId" character varying(21) NOT NULL,
                "projectId" character varying(21),
                "scope" character varying NOT NULL,
                "events" character varying array NOT NULL,
                "url" character varying NOT NULL,
                CONSTRAINT "pk_event_destination" PRIMARY KEY ("id"),
                CONSTRAINT "fk_event_destination_platform_id" FOREIGN KEY ("platformId") REFERENCES "platform"("id") ON DELETE CASCADE,
                CONSTRAINT "fk_event_destination_project_id" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE
            )
        `)
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_event_destination_platform_scope" ON "event_destination" ("platformId") WHERE scope = \'PLATFORM\'')
        await queryRunner.query('CREATE INDEX IF NOT EXISTS "idx_event_destination_project_scope" ON "event_destination" ("projectId") WHERE scope = \'PROJECT\'')

        // --- Store Entry ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "store-entry" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "key" character varying(128) NOT NULL,
                "projectId" character varying(21) NOT NULL,
                "value" jsonb,
                CONSTRAINT "pk_store_entry" PRIMARY KEY ("id"),
                CONSTRAINT "uq_store_entry_project_id_key" UNIQUE ("projectId", "key")
            )
        `)

        // --- Flag ---
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "flag" (
                "id" character varying(21) NOT NULL,
                "created" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "value" jsonb NOT NULL,
                CONSTRAINT "pk_flag" PRIMARY KEY ("id")
            )
        `)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Drop in reverse dependency order
        await queryRunner.query('DROP TABLE IF EXISTS "flag"')
        await queryRunner.query('DROP TABLE IF EXISTS "store-entry"')
        await queryRunner.query('DROP TABLE IF EXISTS "event_destination"')
        await queryRunner.query('DROP TABLE IF EXISTS "platform_analytics_report"')
        await queryRunner.query('DROP TABLE IF EXISTS "template"')
        await queryRunner.query('DROP TABLE IF EXISTS "user_badge"')
        await queryRunner.query('DROP TABLE IF EXISTS "trigger_source"')
        await queryRunner.query('DROP TABLE IF EXISTS "app_event_routing"')
        await queryRunner.query('DROP TABLE IF EXISTS "trigger_event"')
        await queryRunner.query('DROP TABLE IF EXISTS "knowledge_base_chunk"')
        await queryRunner.query('DROP TABLE IF EXISTS "knowledge_base_file"')
        await queryRunner.query('DROP TABLE IF EXISTS "mcp_oauth_token"')
        await queryRunner.query('DROP TABLE IF EXISTS "mcp_oauth_authorization_code"')
        await queryRunner.query('DROP TABLE IF EXISTS "mcp_oauth_client"')
        await queryRunner.query('DROP TABLE IF EXISTS "mcp_server"')
        await queryRunner.query('DROP TABLE IF EXISTS "table_webhook"')
        await queryRunner.query('DROP TABLE IF EXISTS "cell"')
        await queryRunner.query('DROP TABLE IF EXISTS "record"')
        await queryRunner.query('DROP TABLE IF EXISTS "field"')
        await queryRunner.query('DROP TABLE IF EXISTS "table"')
        await queryRunner.query('DROP TABLE IF EXISTS "ai_provider"')
        await queryRunner.query('DROP TABLE IF EXISTS "user_invitation"')
        await queryRunner.query('DROP TABLE IF EXISTS "qadam_tag"')
        await queryRunner.query('DROP TABLE IF EXISTS "tag"')
        await queryRunner.query('DROP TABLE IF EXISTS "qadam_metadata"')
        await queryRunner.query('DROP TABLE IF EXISTS "variable"')
        await queryRunner.query('DROP TABLE IF EXISTS "app_connection"')
        await queryRunner.query('DROP TABLE IF EXISTS "waitpoint"')
        await queryRunner.query('DROP TABLE IF EXISTS "flow_run"')
        await queryRunner.query('ALTER TABLE "flow" DROP CONSTRAINT IF EXISTS "fk_flow_published_version"')
        await queryRunner.query('DROP TABLE IF EXISTS "flow_version"')
        await queryRunner.query('DROP TABLE IF EXISTS "flow"')
        await queryRunner.query('DROP TABLE IF EXISTS "folder"')
        await queryRunner.query('DROP TABLE IF EXISTS "file"')
        await queryRunner.query('DROP TABLE IF EXISTS "project_role"')
        await queryRunner.query('DROP TABLE IF EXISTS "project"')
        await queryRunner.query('DROP TABLE IF EXISTS "concurrency_pool"')
        await queryRunner.query('DROP TABLE IF EXISTS "platform"')
        await queryRunner.query('DROP TABLE IF EXISTS "user"')
        await queryRunner.query('DROP TABLE IF EXISTS "user_identity"')
    }
}
