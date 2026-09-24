import { Project } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../../database/database-common'
import { Waitpoint, WaitpointSlot, WaitpointSlotStatus } from './waitpoint-types'

type WaitpointSlotSchema = WaitpointSlot & {
    project: Project
    waitpoint: Waitpoint
}

// One answer owed to a join waitpoint (#374). The id doubles as the slot's secret: it is the only
// part of a slot callback URL a child cannot learn from its own parent's run id and waitpoint id.
export const WaitpointSlotEntity = new EntitySchema<WaitpointSlotSchema>({
    name: 'waitpoint_slot',
    columns: {
        ...BaseColumnSchemaPart,
        waitpointId: {
            ...ApIdSchema,
            nullable: false,
        },
        flowRunId: {
            ...ApIdSchema,
            nullable: false,
        },
        projectId: {
            ...ApIdSchema,
            nullable: false,
        },
        slotIndex: {
            type: Number,
            nullable: false,
        },
        status: {
            type: String,
            nullable: false,
            enum: WaitpointSlotStatus,
        },
        payload: {
            type: 'text',
            nullable: true,
        },
        childRunId: {
            ...ApIdSchema,
            nullable: true,
        },
    },
    indices: [
        {
            name: 'idx_waitpoint_slot_waitpoint_id_slot_index',
            columns: ['waitpointId', 'slotIndex'],
            unique: true,
        },
        {
            name: 'idx_waitpoint_slot_project_id',
            columns: ['projectId'],
        },
    ],
    relations: {
        project: {
            type: 'many-to-one',
            target: 'project',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'projectId',
                foreignKeyConstraintName: 'fk_waitpoint_slot_project_id',
            },
        },
        waitpoint: {
            type: 'many-to-one',
            target: 'waitpoint',
            cascade: true,
            onDelete: 'CASCADE',
            joinColumn: {
                name: 'waitpointId',
                foreignKeyConstraintName: 'fk_waitpoint_slot_waitpoint_id',
            },
        },
    },
})
