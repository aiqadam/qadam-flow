import { Alert } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import {
    ApIdSchema,
    BaseColumnSchemaPart,
} from '../database/database-common'

export const AlertEntity = new EntitySchema<AlertSchema>({
    name: 'alert',
    columns: {
        ...BaseColumnSchemaPart,
        projectId: {
            ...ApIdSchema,
        },
        channel: {
            type: String,
        },
        receiver: {
            type: String,
            nullable: false,
        },
    },
    indices: [
        {
            name: 'idx_alert_project_id',
            columns: ['projectId'],
            unique: false,
        },
    ],
})

type AlertSchema = Alert
