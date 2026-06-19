import { z } from 'zod'
import { STEP_NAME_REGEX } from '../../../core/common'
import { VersionType } from '../../qadams'
import { CodeActionSettings, LoopOnItemsActionSettings, QadamActionSettings, RouterActionSettings } from '../actions/action'
import { PropertySettings } from '../properties'
import { SampleDataSetting } from '../sample-data'

export const AUTHENTICATION_PROPERTY_NAME = 'auth'


const qadamTriggerSettingsFields = {
    sampleData: SampleDataSetting.optional(),
    propertySettings: z.record(z.string(), PropertySettings),
    customLogoUrl: z.string().optional(),
    qadamName: z.string(),
    qadamVersion: VersionType,
    triggerName: z.string().optional(),
    input: z.record(z.string(), z.any()),
}

export const QadamTriggerSettings = z.object({
    ...qadamTriggerSettingsFields,
})

export type QadamTriggerSettings = z.infer<typeof QadamTriggerSettings>


export enum FlowTriggerType {
    EMPTY = 'EMPTY',
    PIECE = 'PIECE_TRIGGER',
}

const commonProps = {
    name: z.string().regex(STEP_NAME_REGEX),
    valid: z.boolean(),
    displayName: z.string(),
    nextAction: z.any().optional(),
    lastUpdatedDate: z.string(),
}


export const EmptyTrigger = z.object({
    ...commonProps,
    type: z.literal(FlowTriggerType.EMPTY),
    settings: z.any(),
})

export type EmptyTrigger = z.infer<typeof EmptyTrigger>


export const QadamTrigger = z.object({
    ...commonProps,
    type: z.literal(FlowTriggerType.PIECE),
    settings: QadamTriggerSettings,
})

export type QadamTrigger = z.infer<typeof QadamTrigger>

export const FlowTrigger = z.union([
    QadamTrigger,
    EmptyTrigger,
])

export type FlowTrigger = z.infer<typeof FlowTrigger>


export type StepSettings =
  | CodeActionSettings
  | QadamActionSettings
  | QadamTriggerSettings
  | RouterActionSettings
  | LoopOnItemsActionSettings
