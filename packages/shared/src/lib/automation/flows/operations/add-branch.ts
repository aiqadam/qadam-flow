import { insertAt } from '../../../core/common'
import { FlowActionType, RouterAction } from '../actions/action'
import { FlowVersion } from '../flow-version'
import { flowStructureUtil } from '../util/flow-structure-util'
import { routerBranchUtil } from '../util/router-branch-util'
import { AddBranchRequest } from '.'


function _addBranch(flowVersion: FlowVersion, request: AddBranchRequest): FlowVersion {
    return flowStructureUtil.transferFlow(flowVersion, (parentStep) => {
        if (parentStep.name !== request.stepName || parentStep.type !== FlowActionType.ROUTER) {
            return parentStep
        }
        const routerAction = parentStep as RouterAction
        const settings = {
            ...routerAction.settings,
            branches: insertAt(routerAction.settings.branches, request.branchIndex, flowStructureUtil.createBranch(request.branchName, request.conditions)),
        }
        return {
            ...routerAction,
            valid: routerBranchUtil.isSettingsValid(settings),
            settings,
            children: insertAt(routerAction.children, request.branchIndex, null),
        }
    })
}


export { _addBranch }