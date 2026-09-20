import { Cell, Project, Record, Table } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../database/database-common'

export type RecordSchema = Record & {
    table: Table
    project: Project
    cells: Cell[]
}

export const RecordEntity = new EntitySchema<RecordSchema>({
    name: 'record',
    columns: {
        ...BaseColumnSchemaPart,
        tableId: {
            ...ApIdSchema,
            nullable: false,
        },
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        keyValue: {
            type: String,
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_record_project_id_table_id',
            columns: ['projectId', 'tableId'],
        },
        {
            name: 'idx_record_table_id_project_id_record_id',
            columns: ['tableId', 'projectId', 'id'],
        },
        // Partial: `keyValue` is null for every record of a table without a declared key
        // (#409), so this enforces nothing until `table.keyFieldIds` is set and the
        // backfill in table.service.ts populates it.
        {
            name: 'idx_record_project_id_table_id_key_value_unique',
            columns: ['projectId', 'tableId', 'keyValue'],
            where: '"keyValue" IS NOT NULL',
            unique: true,
        },
    ],
    relations: {
        table: {
            type: 'many-to-one',
            target: 'table',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'tableId',
                foreignKeyConstraintName: 'fk_record_table_id',
            },
        },
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_record_project_id',
            },
        },
        cells: {
            type: 'one-to-many',
            target: 'cell',
            inverseSide: 'record',
        },
    },
})