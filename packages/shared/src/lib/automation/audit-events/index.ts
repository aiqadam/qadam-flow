import { z } from 'zod'
import { Flow } from '../../automation/flows/flow'
import { FlowVersion } from '../../automation/flows/flow-version'
import { Folder } from '../../automation/flows/folders/folder'
import { FlowOperationRequest } from '../../automation/flows/operations'
import { BaseModelSchema, DateOrString, Nullable } from '../../core/common/base-model'
import { UserWithMetaInformation } from '../../core/user/user'
const UserMeta = UserWithMetaInformation.pick({ email: true, id: true, firstName: true, lastName: true })

export enum ApplicationEventName {
    FLOW_CREATED = 'flow.created',
    FLOW_DELETED = 'flow.deleted',
    FLOW_UPDATED = 'flow.updated',
    FLOW_PUBLISHED = 'flow.published',
    FLOW_ACTIVATED = 'flow.activated',
    FLOW_DEACTIVATED = 'flow.deactivated',
    FLOW_RUN_RESUMED = 'flow.run.resumed',
    FLOW_RUN_STARTED = 'flow.run.started',
    FLOW_RUN_FINISHED = 'flow.run.finished',
    FLOW_RUN_RETRIED = 'flow.run.retried',
    FOLDER_CREATED = 'folder.created',
    FOLDER_UPDATED = 'folder.updated',
    FOLDER_DELETED = 'folder.deleted',
    CONNECTION_UPSERTED = 'connection.upserted',
    CONNECTION_DELETED = 'connection.deleted',
    VARIABLE_UPSERTED = 'variable.upserted',
    VARIABLE_DELETED = 'variable.deleted',
    VARIABLE_VALUE_REVEALED = 'variable.value.revealed',
    USER_SIGNED_UP = 'user.signed.up',
    USER_SIGNED_IN = 'user.signed.in',
    USER_PASSWORD_RESET = 'user.password.reset',
    USER_EMAIL_VERIFIED = 'user.email.verified',
}

const BaseAuditEventProps = {
    ...BaseModelSchema,
    platformId: z.string(),
    projectId: z.string().optional(),
    projectDisplayName: z.string().optional(),
    userId: z.string().optional(),
    userEmail: z.string().optional(),
    ip: z.string().optional(),
}

const ConnectionEventData = z.object({
    connection: z.object({
        displayName: z.string(),
        externalId: z.string(),
        qadamName: z.string(),
        status: z.string(),
        type: z.string(),
        id: z.string(),
        created: DateOrString,
        updated: DateOrString,
    }),
    project: z.object({
        displayName: z.string(),
    }).optional(),
})

export const ConnectionEvent = z.object({
    ...BaseAuditEventProps,
    action: z.union([
        z.literal(ApplicationEventName.CONNECTION_DELETED),
        z.literal(ApplicationEventName.CONNECTION_UPSERTED),
    ]),
    data: ConnectionEventData,
})
export type ConnectionEvent = z.infer<typeof ConnectionEvent>

export const ConnectionUpsertedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.CONNECTION_UPSERTED),
    data: ConnectionEventData,
})
export type ConnectionUpsertedEvent = z.infer<typeof ConnectionUpsertedEvent>

export const ConnectionDeletedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.CONNECTION_DELETED),
    data: ConnectionEventData,
})
export type ConnectionDeletedEvent = z.infer<typeof ConnectionDeletedEvent>

const VariableEventData = z.object({
    variable: z.object({
        id: z.string(),
        name: z.string(),
        created: DateOrString,
        updated: DateOrString,
    }),
    project: z.object({
        displayName: z.string(),
    }).optional(),
})

export const VariableEvent = z.object({
    ...BaseAuditEventProps,
    action: z.union([
        z.literal(ApplicationEventName.VARIABLE_UPSERTED),
        z.literal(ApplicationEventName.VARIABLE_DELETED),
        z.literal(ApplicationEventName.VARIABLE_VALUE_REVEALED),
    ]),
    data: VariableEventData,
})
export type VariableEvent = z.infer<typeof VariableEvent>

export const VariableUpsertedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.VARIABLE_UPSERTED),
    data: VariableEventData,
})
export type VariableUpsertedEvent = z.infer<typeof VariableUpsertedEvent>

export const VariableDeletedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.VARIABLE_DELETED),
    data: VariableEventData,
})
export type VariableDeletedEvent = z.infer<typeof VariableDeletedEvent>

export const VariableValueRevealedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.VARIABLE_VALUE_REVEALED),
    data: VariableEventData,
})
export type VariableValueRevealedEvent = z.infer<typeof VariableValueRevealedEvent>

const FolderEventData = z.object({
    folder: Folder.pick({ id: true, displayName: true, created: true, updated: true }),
    project: z.object({
        displayName: z.string(),
    }).optional(),
})

export const FolderEvent = z.object({
    ...BaseAuditEventProps,
    action: z.union([
        z.literal(ApplicationEventName.FOLDER_UPDATED),
        z.literal(ApplicationEventName.FOLDER_CREATED),
        z.literal(ApplicationEventName.FOLDER_DELETED),
    ]),
    data: FolderEventData,
})

export type FolderEvent = z.infer<typeof FolderEvent>

export const FolderCreatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FOLDER_CREATED),
    data: FolderEventData,
})
export type FolderCreatedEvent = z.infer<typeof FolderCreatedEvent>

export const FolderUpdatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FOLDER_UPDATED),
    data: FolderEventData,
})
export type FolderUpdatedEvent = z.infer<typeof FolderUpdatedEvent>

export const FolderDeletedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FOLDER_DELETED),
    data: FolderEventData,
})
export type FolderDeletedEvent = z.infer<typeof FolderDeletedEvent>

const FlowRunEventData = z.object({
    flowRun: z.object({
        id: z.string(),
        startTime: z.string().nullish(),
        finishTime: z.string().nullish(),
        duration: z.number().optional(),
        triggeredBy: z.string().optional(),
        environment: z.string(),
        flowId: z.string(),
        flowVersionId: z.string(),
        stepNameToTest: z.string().optional(),
        flowDisplayName: z.string().optional(),
        status: z.string(),
    }),
    project: z.object({
        displayName: z.string(),
    }).optional(),
})

export const FlowRunEvent = z.object({
    ...BaseAuditEventProps,
    action: z.union([
        z.literal(ApplicationEventName.FLOW_RUN_STARTED),
        z.literal(ApplicationEventName.FLOW_RUN_FINISHED),
        z.literal(ApplicationEventName.FLOW_RUN_RESUMED),
        z.literal(ApplicationEventName.FLOW_RUN_RETRIED),
    ]),
    data: FlowRunEventData,
})
export type FlowRunEvent = z.infer<typeof FlowRunEvent>

export const FlowRunStartedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_RUN_STARTED),
    data: FlowRunEventData,
})
export type FlowRunStartedEvent = z.infer<typeof FlowRunStartedEvent>

export const FlowRunFinishedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_RUN_FINISHED),
    data: FlowRunEventData,
})
export type FlowRunFinishedEvent = z.infer<typeof FlowRunFinishedEvent>

export const FlowRunRetriedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_RUN_RETRIED),
    data: FlowRunEventData,
})
export type FlowRunRetriedEvent = z.infer<typeof FlowRunRetriedEvent>

export const FlowCreatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_CREATED),
    data: z.object({
        flow: Flow.pick({ id: true, externalId: true, created: true, updated: true }),
        project: z.object({
            displayName: z.string(),
            externalId: Nullable(z.string()),
        }).optional(),
    }),
})

export type FlowCreatedEvent = z.infer<typeof FlowCreatedEvent>

export const FlowDeletedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_DELETED),
    data: z.object({
        flow: Flow.pick({ id: true, externalId: true, created: true, updated: true }),
        flowVersion: FlowVersion.pick({
            id: true,
            displayName: true,
            flowId: true,
            created: true,
            updated: true,
        }),
        project: z.object({
            displayName: z.string(),
            externalId: Nullable(z.string()),
        }).optional(),
    }),
})

export type FlowDeletedEvent = z.infer<typeof FlowDeletedEvent>

export const FlowUpdatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_UPDATED),
    data: z.object({
        flow: Flow.pick({ id: true, externalId: true, created: true, updated: true }),
        flowVersion: FlowVersion.pick({
            id: true,
            displayName: true,
            flowId: true,
            created: true,
            updated: true,
        }),
        request: FlowOperationRequest,
        project: z.object({
            displayName: z.string(),
            externalId: Nullable(z.string()),
        }).optional(),
    }),
})

export type FlowUpdatedEvent = z.infer<typeof FlowUpdatedEvent>

const FlowLifecycleEventData = z.object({
    flow: Flow.pick({ id: true, externalId: true, created: true, updated: true }),
    flowVersion: FlowVersion.pick({
        id: true,
        displayName: true,
        flowId: true,
        created: true,
        updated: true,
    }),
    project: z.object({
        displayName: z.string(),
        externalId: Nullable(z.string()),
    }).optional(),
})

export const FlowPublishedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_PUBLISHED),
    data: FlowLifecycleEventData,
})

export type FlowPublishedEvent = z.infer<typeof FlowPublishedEvent>

export const FlowActivatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_ACTIVATED),
    data: FlowLifecycleEventData,
})

export type FlowActivatedEvent = z.infer<typeof FlowActivatedEvent>

export const FlowDeactivatedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.FLOW_DEACTIVATED),
    data: FlowLifecycleEventData,
})

export type FlowDeactivatedEvent = z.infer<typeof FlowDeactivatedEvent>

const AuthenticationEventData = z.object({
    user: UserMeta.optional(),
})

export const AuthenticationEvent = z.object({
    ...BaseAuditEventProps,
    action: z.union([
        z.literal(ApplicationEventName.USER_SIGNED_IN),
        z.literal(ApplicationEventName.USER_PASSWORD_RESET),
        z.literal(ApplicationEventName.USER_EMAIL_VERIFIED),
    ]),
    data: AuthenticationEventData,
})

export type AuthenticationEvent = z.infer<typeof AuthenticationEvent>

export const UserSignedInEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.USER_SIGNED_IN),
    data: AuthenticationEventData,
})
export type UserSignedInEvent = z.infer<typeof UserSignedInEvent>

export const UserPasswordResetEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.USER_PASSWORD_RESET),
    data: AuthenticationEventData,
})
export type UserPasswordResetEvent = z.infer<typeof UserPasswordResetEvent>

export const UserEmailVerifiedEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.USER_EMAIL_VERIFIED),
    data: AuthenticationEventData,
})
export type UserEmailVerifiedEvent = z.infer<typeof UserEmailVerifiedEvent>

export const SignUpEvent = z.object({
    ...BaseAuditEventProps,
    action: z.literal(ApplicationEventName.USER_SIGNED_UP),
    data: z.object({
        source: z.union([
            z.literal('credentials'),
            z.literal('sso'),
            z.literal('managed'),
        ]),
        user: UserMeta.optional(),
    }),
})
export type SignUpEvent = z.infer<typeof SignUpEvent>

export const ApplicationEvent = z.union([
    ConnectionEvent,
    VariableEvent,
    FlowCreatedEvent,
    FlowDeletedEvent,
    FlowUpdatedEvent,
    FlowPublishedEvent,
    FlowActivatedEvent,
    FlowDeactivatedEvent,
    FlowRunEvent,
    AuthenticationEvent,
    FolderEvent,
    SignUpEvent,
])

export type ApplicationEvent = z.infer<typeof ApplicationEvent>
