import { ApplicationEvent, ApplicationEventName, BADGES, FlowActionType, FlowOperationType, flowStructureUtil, FlowTriggerType, FlowUpdatedEvent, isNil } from '@aiqadam/shared'
import { flowVersionRepo } from '../../../flows/flow-version/flow-version.service'
import { BadgeCheck, BadgeCheckResult } from '../badge-check'

const WEBHOOK_PIECE_NAME = '@aiqadam/qadam-webhook'
const AI_PIECE_NAME = '@aiqadam/qadam-ai'

export const flowContentBadgesCheck: BadgeCheck = {
    eval: async (event: ApplicationEvent): Promise<BadgeCheckResult> => {
        const userId = event.userId
        if (isNil(userId)) {
            return { userId: null, badges: [] }
        }
        if (event.action !== ApplicationEventName.FLOW_UPDATED) {
            return { userId, badges: [] }
        }
        const flowUpdatedEvent = event as FlowUpdatedEvent
        if (flowUpdatedEvent.data.request.type !== FlowOperationType.LOCK_AND_PUBLISH) {
            return { userId, badges: [] }
        }
        const flowVersionId = flowUpdatedEvent.data.flowVersion.id
        const flowVersion = await flowVersionRepo().findOneBy({ id: flowVersionId })
        if (!flowVersion || !flowVersion.trigger) {
            return { userId, badges: [] }
        }
        const badges: (keyof typeof BADGES)[] = []
        const allSteps = flowStructureUtil.getAllSteps(flowVersion.trigger)

        const hasWebhook = allSteps.some(step =>
            step.type === FlowTriggerType.PIECE &&
            step.settings?.qadamName === WEBHOOK_PIECE_NAME,
        )
        if (hasWebhook) {
            badges.push('webhook-wizard')
        }

        const hasAI = allSteps.some(step =>
            (step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE) &&
            step.settings?.qadamName === AI_PIECE_NAME,
        )
        if (hasAI) {
            badges.push('agentic-genius')
        }

        const hasCode = allSteps.some(step => step.type === FlowActionType.CODE)
        if (hasCode) {
            badges.push('coding-chad')
        }

        return { userId, badges }
    },
}

