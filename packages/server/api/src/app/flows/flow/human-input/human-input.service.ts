import { ChatUIResponse, ErrorCode, FlowId, FormInputType, FormResponse, isNil, PopulatedFlow, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { platformService } from '../../../platform/platform.service'
import { projectService } from '../../../project/project-service'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { flowVersionService } from '../../flow-version/flow-version.service'
import { flowRepo } from '../flow.repo'

const FORMS_PIECE_NAME = '@aiqadam/qadam-forms'
const FORM_TRIIGGER = 'form_submission'
const FILE_TRIGGER = 'file_submission'
const SIMPLE_FILE_PROPS = {
    inputs: [
        {
            displayName: 'File',
            description: '',
            type: FormInputType.FILE,
            required: true,
        },
    ],
    waitForResponse: true,
}
const FORMS_TRIGGER_NAMES = [
    FORM_TRIIGGER,
    FILE_TRIGGER,
]

function isFormTrigger(flow: PopulatedFlow | null): flow is PopulatedFlow {
    if (isNil(flow)) {
        return false
    }
    const triggerSettings = flow.version.trigger.settings
    return triggerSettings.qadamName === FORMS_PIECE_NAME && FORMS_TRIGGER_NAMES.includes(triggerSettings.triggerName)
}

export const humanInputService = (log: FastifyBaseLogger) => ({
    getFormByFlowIdOrThrow: async (flowId: string, useDraft: boolean): Promise<FormResponse> => {
        const flow = await getPopulatedFlowById(log, flowId, useDraft)
        if (!isFormTrigger(flow)) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'flow_form',
                    entityId: flowId,
                    message: 'Flow form not found in draft version of flow.',
                },
            })
        }
        const qadamVersion = await qadamMetadataService(log).resolveExactVersion({
            name: FORMS_PIECE_NAME,
            version: flow.version.trigger.settings.qadamVersion,
            platformId: await projectService(log).getPlatformId(flow.projectId),
        })
        const triggerSettings = flow.version.trigger.settings
        return {
            id: flow.id,
            title: flow.version.displayName,
            props: triggerSettings.triggerName === FILE_TRIGGER ? SIMPLE_FILE_PROPS : triggerSettings.input,
            projectId: flow.projectId,
            version: qadamVersion,
        }
    },
    getChatUIByFlowIdOrThrow: async (flowId: string, useDraft: boolean): Promise<ChatUIResponse> => {
        const flow = await getPopulatedFlowById(log, flowId, useDraft)
        if (!flow
            || flow.version.trigger.settings.triggerName !== 'chat_submission'
            || flow.version.trigger.settings.qadamName !== FORMS_PIECE_NAME) {
            throw new QadamFlowError({
                code: ErrorCode.ENTITY_NOT_FOUND,
                params: {
                    entityType: 'flow_form',
                    entityId: flowId,
                    message: 'Flow chat ui not found in draft version of flow.',
                },
            })
        }
        const platformId = await projectService(log).getPlatformId(flow.projectId)
        const platform = await platformService(log).getOneOrThrow(platformId)
        return {
            id: flow.id,
            title: flow.version.displayName,
            props: flow.version.trigger.settings.input,
            projectId: flow.projectId,
            platformLogoUrl: platform.logoIconUrl,
            platformName: platform.name,
        }
    },
})

async function getPopulatedFlowById(log: FastifyBaseLogger, id: FlowId, useDraft: boolean): Promise<PopulatedFlow | null> {
    const flow = await flowRepo().findOneBy({ id })
    if (isNil(flow) || (isNil(flow.publishedVersionId) && !useDraft)) {
        return null
    }
    const flowVersion = await flowVersionService(log).getFlowVersionOrThrow({
        flowId: id,
        versionId: useDraft ? undefined : flow.publishedVersionId!,
    })
    return {
        ...flow,
        version: flowVersion,
    }
}