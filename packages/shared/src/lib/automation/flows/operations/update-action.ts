import dayjs from 'dayjs'
import { isNil } from '../../../core/common'
import { FlowAction, FlowActionType, SingleActionSchema } from '../actions/action'
import { FlowVersion } from '../flow-version'
import { flowStructureUtil } from '../util/flow-structure-util'
import { routerBranchUtil } from '../util/router-branch-util'
import { UpdateActionRequest } from './index'

function _updateAction(flowVersion: FlowVersion, request: UpdateActionRequest): FlowVersion {
    const next = flowStructureUtil.transferFlow(flowVersion, (stepToUpdate) => {
        if (stepToUpdate.name !== request.name) {
            return stepToUpdate
        }

        const baseProps: Omit<FlowAction, 'type'> = {
            displayName: request.displayName,
            name: request.name,
            valid: false,
            skip: request.skip,
            lastUpdatedDate: dayjs().toISOString(),
            logInput: request.logInput,
            logOutput: request.logOutput,
            settings: {
                ...stepToUpdate.settings,
                customLogoUrl: request.settings.customLogoUrl,
            },
        }


        let updatedAction: FlowAction
        switch (request.type) {
            case FlowActionType.CODE: {
                const existingContinueOnFailureBranches = stepToUpdate.type === FlowActionType.CODE || stepToUpdate.type === FlowActionType.PIECE ? stepToUpdate.continueOnFailureBranches : undefined
                const existingSampleData = stepToUpdate.type === FlowActionType.CODE ? stepToUpdate.settings.sampleData : undefined
                updatedAction = {
                    ...baseProps,
                    settings: { ...request.settings, sampleData: existingSampleData },
                    type: FlowActionType.CODE,
                    nextAction: stepToUpdate.nextAction,
                    continueOnFailureBranches: existingContinueOnFailureBranches,
                }
                break
            }
            case FlowActionType.PIECE: {
                const existingContinueOnFailureBranches = stepToUpdate.type === FlowActionType.CODE || stepToUpdate.type === FlowActionType.PIECE ? stepToUpdate.continueOnFailureBranches : undefined
                const existingSampleData = stepToUpdate.type === FlowActionType.PIECE ? stepToUpdate.settings.sampleData : undefined
                updatedAction = {
                    ...baseProps,
                    settings: { ...request.settings, sampleData: existingSampleData },
                    type: FlowActionType.PIECE,
                    nextAction: stepToUpdate.nextAction,
                    continueOnFailureBranches: existingContinueOnFailureBranches,
                }
                break
            }
            case FlowActionType.LOOP_ON_ITEMS: {
                const existingSampleData = stepToUpdate.type === FlowActionType.LOOP_ON_ITEMS ? stepToUpdate.settings.sampleData : undefined
                const firstLoopAction = stepToUpdate.type === FlowActionType.LOOP_ON_ITEMS ? stepToUpdate.firstLoopAction : undefined
                updatedAction = {
                    ...baseProps,
                    settings: { ...request.settings, sampleData: existingSampleData },
                    type: FlowActionType.LOOP_ON_ITEMS,
                    firstLoopAction,
                    nextAction: stepToUpdate.nextAction,
                }
                break
            }

            case FlowActionType.ROUTER: {
                const existingSampleData = stepToUpdate.type === FlowActionType.ROUTER ? stepToUpdate.settings.sampleData : undefined
                const children = stepToUpdate.type === FlowActionType.ROUTER ? stepToUpdate.children : [null, null]
                updatedAction = {
                    ...baseProps,
                    settings: { ...request.settings, sampleData: existingSampleData },
                    type: FlowActionType.ROUTER,
                    nextAction: stepToUpdate.nextAction,
                    children,
                }
                break
            }
        }
        const parseResult = SingleActionSchema.safeParse(updatedAction)
        // Same bypass as `createAction`: UPDATE_ACTION sub-operations expanded inside
        // `flowOperations.apply` never see `prepareRequest`, so recompute router validity here (#436).
        const routerValid = request.type === FlowActionType.ROUTER ? routerBranchUtil.isSettingsValid(request.settings) : true
        const valid = (isNil(request.valid) ? true : request.valid) && parseResult.success && routerValid
        return {
            ...updatedAction,
            valid,
        }
    })
    return next
}

export { _updateAction }
