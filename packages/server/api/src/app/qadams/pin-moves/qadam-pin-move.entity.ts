import { Flow, FlowVersion, Platform, Project } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../database/database-common'
import { QadamPinMove } from './qadam-pin-move.dto'

export const QadamPinMoveEntity = new EntitySchema<QadamPinMoveSchema>({
    name: 'qadam_pin_move',
    columns: {
        ...BaseColumnSchemaPart,
        platformId: {
            ...ApIdSchema,
            nullable: false,
        },
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        flowId: {
            ...ApIdSchema,
            nullable: false,
        },
        flowVersionId: {
            ...ApIdSchema,
            nullable: false,
        },
        stepName: {
            type: String,
            nullable: false,
        },
        qadamName: {
            type: String,
            nullable: false,
        },
        fromVersion: {
            type: String,
            nullable: false,
        },
        toVersion: {
            type: String,
            nullable: false,
        },
        propsCheck: {
            type: String,
            nullable: false,
        },
        cause: {
            type: String,
            nullable: false,
        },
        status: {
            type: String,
            nullable: false,
        },
        movedBy: {
            type: String,
            nullable: true,
        },
        revertedAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        revertedBy: {
            type: String,
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_qadam_pin_move_platform_id_created',
            columns: ['platformId', 'created'],
            unique: false,
        },
        {
            name: 'idx_qadam_pin_move_flow_id',
            columns: ['flowId'],
            unique: false,
        },
        {
            name: 'idx_qadam_pin_move_flow_version_id',
            columns: ['flowVersionId'],
            unique: false,
        },
    ],
    relations: {
        platform: {
            type: 'many-to-one',
            target: 'platform',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'platformId',
                foreignKeyConstraintName: 'fk_qadam_pin_move_platform_id',
            },
        },
        project: {
            type: 'many-to-one',
            target: 'project',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_qadam_pin_move_project_id',
            },
        },
        flow: {
            type: 'many-to-one',
            target: 'flow',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'flowId',
                foreignKeyConstraintName: 'fk_qadam_pin_move_flow_id',
            },
        },
        flowVersion: {
            type: 'many-to-one',
            target: 'flow_version',
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'flowVersionId',
                foreignKeyConstraintName: 'fk_qadam_pin_move_flow_version_id',
            },
        },
    },
})

type QadamPinMoveSchema = QadamPinMove & {
    platform: Platform
    project: Project
    flow: Flow
    flowVersion: FlowVersion
}
