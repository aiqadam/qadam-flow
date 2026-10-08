import { QadamMetadataModel } from '@aiqadam/qadams-framework'
import {
    ApId,
    BaseModel,
} from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import {
    ApIdSchema,
    BaseColumnSchemaPart,
    COLLATION,
} from '../../database/database-common'
import { QadamContextVersion } from './qadam-context-version'

export const QadamMetadataEntity =
    new EntitySchema<QadamMetadataSchema>({
        name: 'qadam_metadata',
        columns: {
            ...BaseColumnSchemaPart,
            name: {
                type: String,
                nullable: false,
            },
            authors: {
                type: String,
                nullable: false,
                array: true,
            },
            displayName: {
                type: String,
                nullable: false,
            },
            logoUrl: {
                type: String,
                nullable: false,
            },
            projectUsage: {
                type: Number,
                nullable: false,
                default: 0,
            },
            description: {
                type: String,
                nullable: true,
            },
            platformId: {
                type: String,
                nullable: true,
            },
            version: {
                type: String,
                nullable: false,
                collation: COLLATION,
            },
            minimumSupportedRelease: {
                type: String,
                nullable: false,
                collation: COLLATION,
            },
            maximumSupportedRelease: {
                type: String,
                nullable: false,
                collation: COLLATION,
            },
            auth: {
                type: 'json',
                nullable: true,
            },
            actions: {
                type: 'json',
                nullable: false,
            },
            triggers: {
                type: 'json',
                nullable: false,
            },
            qadamType: {
                type: String,
                nullable: false,
            },
            categories: {
                type: String,
                nullable: true,
                array: true,
            },
            packageType: {
                type: String,
                nullable: false,
            },
            archiveId: {
                ...ApIdSchema,
                nullable: true,
            },
            i18n: {
                type: 'json',
                nullable: true,
            },
            // The context version the qadam reports (`getContextInfo`), for the ADR-0002 census
            // (#803): a ContextVersion, NONE or UNRECOGNISED (`qadam-context-version.ts`). NULL
            // means not measured yet, or the qadam could not be loaded. The census counts every
            // value except V2 as still needing the old contract.
            contextVersion: {
                type: String,
                nullable: true,
            },
            // How often the backfill failed to load this row, and when it last tried: it retries
            // with a growing interval and stops at a small maximum (`qadam-context-version-backfill.ts`).
            contextVersionAttempts: {
                type: Number,
                nullable: false,
                default: 0,
            },
            contextVersionLastAttemptAt: {
                type: 'timestamp with time zone',
                nullable: true,
            },
        },
        indices: [
            {
                name: 'idx_qadam_metadata_name_platform_id_version',
                columns: ['name', 'version', 'platformId'],
                unique: true,
            },
        ],
        relations: {
            archiveId: {
                type: 'one-to-one',
                target: 'file',
                onDelete: 'RESTRICT',
                onUpdate: 'RESTRICT',
                joinColumn: {
                    name: 'archiveId',
                    referencedColumnName: 'id',
                    foreignKeyConstraintName: 'fk_qadam_metadata_file',
                },
            },
        },
    })

export type QadamMetadataSchema = BaseModel<ApId> & QadamMetadataModel & {
    // Optional: `loadBundledQadams` types bundled qadams as this schema too, and they have no row.
    contextVersion?: QadamContextVersion | null
    contextVersionAttempts?: number
    contextVersionLastAttemptAt?: string | null
}
