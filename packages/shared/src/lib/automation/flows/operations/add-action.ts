import dayjs from 'dayjs'
import { isNil } from '../../../core/common'
import { ErrorCode, QadamFlowError } from '../../../core/common/qadam-flow-error'
import { FlowAction, FlowActionType, LoopOnItemsAction, RouterAction, SingleActionSchema } from '../actions/action'
import { FlowVersion } from '../flow-version'
import { flowStructureUtil, Step } from '../util/flow-structure-util'
import { routerBranchUtil } from '../util/router-branch-util'
import { AddActionRequest, StepLocationRelativeToParent, UpdateActionRequest } from './index'

type ActionCreationProps = {
    nextAction?: FlowAction
}

function createAction(request: UpdateActionRequest, {
    nextAction,
}: ActionCreationProps): FlowAction {
    const baseProperties = {
        displayName: request.displayName,
        name: request.name,
        valid: false,
        skip: request.skip,
        lastUpdatedDate: dayjs().toISOString(),
        logInput: request.logInput,
        logOutput: request.logOutput,
        settings: {
            ...request.settings,
            customLogoUrl: request.settings.customLogoUrl,
        },
        nextAction,
    }
    let action: FlowAction
    switch (request.type) {
        case FlowActionType.ROUTER:
            action = {
                ...baseProperties,
                type: FlowActionType.ROUTER,
                settings: request.settings,
                children: request.settings.branches.map(() => null),
            }

            break
        case FlowActionType.LOOP_ON_ITEMS:
            action = {
                ...baseProperties,
                type: FlowActionType.LOOP_ON_ITEMS,
                settings: request.settings,
            }
            break
        case FlowActionType.PIECE:
            action = {
                ...baseProperties,
                type: FlowActionType.PIECE,
                settings: request.settings,
            }
            break
        case FlowActionType.CODE:
            action = {
                ...baseProperties,
                type: FlowActionType.CODE,
                settings: request.settings,
            }
            break
    }
    const parseResult = SingleActionSchema.safeParse(action)
    // IMPORT_FLOW expands into ADD_ACTION sub-operations inside `flowOperations.apply`, i.e. after
    // `prepareRequest` — so the caller's `valid` flag arrives untouched and the non-validating
    // `RouterActionSettings` parse above accepts a condition-less branch. Recompute router validity
    // here so every path that bypasses `prepareRequest` gets the same gate (#436).
    const routerValid = request.type === FlowActionType.ROUTER ? routerBranchUtil.isSettingsValid(request.settings) : true
    const valid = (isNil(request.valid) ? true : request.valid) && parseResult.success && routerValid
    return {
        ...action,
        valid,
    }
}

function handleLoopOnItems(parentStep: LoopOnItemsAction, request: AddActionRequest): Step {
    if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_LOOP) {
        parentStep.firstLoopAction = createAction(request.action, {
            nextAction: parentStep.firstLoopAction,
        })
    }
    else if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.AFTER) {
        parentStep.nextAction = createAction(request.action, {
            nextAction: parentStep.nextAction,
        })
    }
    else {
        throw new QadamFlowError(
            {
                code: ErrorCode.FLOW_OPERATION_INVALID,
                params: {
                    message: `Loop step parent ${request.stepLocationRelativeToParent} not found`,
                },
            })
    }
    return parentStep
}

function handleRouter(parentStep: RouterAction, request: AddActionRequest): Step {
    if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_BRANCH && !isNil(request.branchIndex)) {
        parentStep.children[request.branchIndex] = createAction(request.action, {
            nextAction: parentStep.children[request.branchIndex] ?? undefined,
        })
    }
    else if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.AFTER) {
        parentStep.nextAction = createAction(request.action, {
            nextAction: parentStep.nextAction,
        })
    }
    else {
        throw new QadamFlowError({
            code: ErrorCode.FLOW_OPERATION_INVALID,
            params: {
                message: `Router step parent ${request.stepLocationRelativeToParent} not found`,
            },
        })
    }
    return parentStep
}

function handleContinueOnFailureBranches(parentStep: Step, request: AddActionRequest): Step {
    if (parentStep.type !== FlowActionType.CODE && parentStep.type !== FlowActionType.PIECE) {
        throw new QadamFlowError({
            code: ErrorCode.FLOW_OPERATION_INVALID,
            params: {
                message: `Continue-on-failure branches are only available on Code and Piece actions, got ${parentStep.type}`,
            },
        })
    }
    const branches = parentStep.continueOnFailureBranches ?? {}
    if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_ON_SUCCESS_BRANCH) {
        branches.onSuccess = createAction(request.action, {
            nextAction: branches.onSuccess,
        })
    }
    else if (request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_ON_FAILURE_BRANCH) {
        branches.onFailure = createAction(request.action, {
            nextAction: branches.onFailure,
        })
    }
    parentStep.continueOnFailureBranches = branches
    return parentStep
}

function _addAction(flowVersion: FlowVersion, request: AddActionRequest): FlowVersion {
    return flowStructureUtil.transferFlow(flowVersion, (parentStep: Step) => {
        if (parentStep.name !== request.parentStep) {
            return parentStep
        }
        if (
            request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_ON_SUCCESS_BRANCH ||
            request.stepLocationRelativeToParent === StepLocationRelativeToParent.INSIDE_ON_FAILURE_BRANCH
        ) {
            return handleContinueOnFailureBranches(parentStep, request)
        }
        switch (parentStep.type) {
            case FlowActionType.LOOP_ON_ITEMS:
                return handleLoopOnItems(parentStep, request)
            case FlowActionType.ROUTER:
                return handleRouter(parentStep, request)
            default: {
                parentStep.nextAction = createAction(request.action, {
                    nextAction: parentStep.nextAction,
                })
                return parentStep
            }
        }
    })
}

export { _addAction }
