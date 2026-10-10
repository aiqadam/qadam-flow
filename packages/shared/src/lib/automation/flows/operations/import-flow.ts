import { isNil } from '../../../core/common'
import { FlowAction, FlowActionType } from '../actions/action'
import { FlowVersion } from '../flow-version'
import { FlowTrigger, FlowTriggerType } from '../triggers/trigger'
import { flowQadamUtil } from '../util/flow-qadam-util'
import { flowStructureUtil } from '../util/flow-structure-util'
import { AddNoteRequest, DeleteNoteRequest, FlowOperationRequest, FlowOperationType, ImportFlowRequest, StepLocationRelativeToParent } from './index'

function createDeleteActionOperation(actionName: string): FlowOperationRequest {
    return {
        type: FlowOperationType.DELETE_ACTION,
        request: { names: [actionName] },
    }
}

function createUpdateTriggerOperation(trigger: FlowTrigger): FlowOperationRequest {
    return {
        type: FlowOperationType.UPDATE_TRIGGER,
        request: trigger,
    }
}

function createChangeNameOperation(displayName: string): FlowOperationRequest {
    return {
        type: FlowOperationType.CHANGE_NAME,
        request: { displayName },
    }
}

function createUpdateLocaleSourceOperation(localeSource: string | null): FlowOperationRequest {
    return {
        type: FlowOperationType.UPDATE_LOCALE_SOURCE,
        request: { localeSource },
    }
}

function _getImportOperationsForSteps(step: FlowAction | FlowTrigger | undefined): FlowOperationRequest[] {
    const steps: FlowOperationRequest[] = []
    while (step) {
        if (step.nextAction) {
            steps.push({
                type: FlowOperationType.ADD_ACTION,
                request: {
                    parentStep: step?.name ?? '',
                    stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER,
                    action: removeAnySubsequentAction(step.nextAction),
                },
            })
        }
        switch (step.type) {
            case FlowActionType.LOOP_ON_ITEMS: {
                if (step.firstLoopAction) {
                    steps.push({
                        type: FlowOperationType.ADD_ACTION,
                        request: {
                            parentStep: step.name,
                            stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_LOOP,
                            action: removeAnySubsequentAction(step.firstLoopAction),
                        },
                    })
                    steps.push(..._getImportOperationsForSteps(step.firstLoopAction))
                }
                break
            }
            case FlowActionType.ROUTER: {
                if (step.children) {
                    for (const [index, child] of step.children.entries()) {
                        if (!isNil(child)) {
                            steps.push({
                                type: FlowOperationType.ADD_ACTION,
                                request: {
                                    parentStep: step.name,
                                    stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH,
                                    branchIndex: index,
                                    action: removeAnySubsequentAction(child),
                                },
                            })
                            steps.push(..._getImportOperationsForSteps(child))
                        }
                    }
                }
                break
            }
            case FlowActionType.CODE:
            case FlowActionType.PIECE: {
                const branches = step.continueOnFailureBranches
                if (!isNil(branches?.onSuccess)) {
                    steps.push({
                        type: FlowOperationType.ADD_ACTION,
                        request: {
                            parentStep: step.name,
                            stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_ON_SUCCESS_BRANCH,
                            action: removeAnySubsequentAction(branches.onSuccess),
                        },
                    })
                    steps.push(..._getImportOperationsForSteps(branches.onSuccess))
                }
                if (!isNil(branches?.onFailure)) {
                    steps.push({
                        type: FlowOperationType.ADD_ACTION,
                        request: {
                            parentStep: step.name,
                            stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_ON_FAILURE_BRANCH,
                            action: removeAnySubsequentAction(branches.onFailure),
                        },
                    })
                    steps.push(..._getImportOperationsForSteps(branches.onFailure))
                }
                break
            }
            case FlowTriggerType.PIECE:
            case FlowTriggerType.EMPTY: {
                break
            }
        }

        step = step.nextAction
    }
    return steps
}

function _getImportOperationsForNotes(flowVersion: FlowVersion, request: ImportFlowRequest): FlowOperationRequest[] { 

    const deleteOperations: DeleteNoteRequest[] = flowVersion.notes.map(note => ({
        id: note.id,
    }))
    const addOperations: AddNoteRequest[] = (request.notes || []).map(note => (note))

    const operations: FlowOperationRequest[] = [
        ...deleteOperations.map(operation => ({
            type: FlowOperationType.DELETE_NOTE as const,
            request: operation,
        })),
        ...addOperations.map(operation => ({
            type: FlowOperationType.ADD_NOTE as const,
            request: operation,
        })),
    ]
    return operations
}
function removeAnySubsequentAction(action: FlowAction): FlowAction {
    const clonedAction: FlowAction = JSON.parse(JSON.stringify(action))
    switch (clonedAction.type) {
        case FlowActionType.ROUTER: {
            clonedAction.children = clonedAction.children.map((child: FlowAction | null) => {
                if (isNil(child)) {
                    return null
                }
                return removeAnySubsequentAction(child)
            })
            break
        }
        case FlowActionType.LOOP_ON_ITEMS: {
            delete clonedAction.firstLoopAction
            break
        }
        case FlowActionType.PIECE:
        case FlowActionType.CODE: {
            delete clonedAction.continueOnFailureBranches
            break
        }
    }
    delete clonedAction.nextAction
    return clonedAction
}

// ADR-0004: the exporter listed these steps because it could not confirm a compatible release, so
// each is marked "update this step", even when the release its caret names exists. The importer is
// the only writer of the mark: any marker the file brought is dropped first, and a listed name whose
// qadam is not the step's marks nothing.
function markExportedUnresolved({ trigger, steps }: { trigger: FlowTrigger, steps: ImportFlowRequest['exportedUnresolved'] }): FlowTrigger {
    const marked: FlowTrigger = structuredClone(trigger)
    const markable = flowQadamUtil.getMarkableUnresolved({ trigger: marked, steps })
    for (const step of flowStructureUtil.getAllSteps(marked)) {
        if (step.type !== FlowActionType.PIECE && step.type !== FlowTriggerType.PIECE) {
            continue
        }
        delete step.settings.exportedUnresolvedPin
        if (markable.some((entry) => entry.stepName === step.name && entry.qadamName === step.settings.qadamName)) {
            step.settings.exportedUnresolvedPin = flowQadamUtil.getExactVersion(step.settings.qadamVersion)
        }
    }
    return marked
}

function _importFlow(flowVersion: FlowVersion, request: ImportFlowRequest): FlowOperationRequest[] {
    const existingActions = flowStructureUtil.getAllNextActionsWithoutChildren(flowVersion.trigger)
    const trigger = markExportedUnresolved({ trigger: request.trigger, steps: request.exportedUnresolved })

    const deleteOperations = existingActions.map(action =>
        createDeleteActionOperation(action.name),
    )

    const importOperations = _getImportOperationsForSteps(trigger)
 
    return [
        createChangeNameOperation(request.displayName),
        // `undefined` means "the caller expressed no opinion" (a duplicate/use-as-draft path that
        // never read `localeSource` off its source version) and must leave the target's existing
        // value untouched — only `null`/a string is an explicit instruction to clear or set it.
        // Emitting the operation unconditionally used to coalesce `undefined` to `null` here,
        // silently wiping `localeSource` on every import that did not carry it.
        ...(request.localeSource !== undefined ? [createUpdateLocaleSourceOperation(request.localeSource)] : []),
        ...deleteOperations,
        createUpdateTriggerOperation(trigger),
        ...importOperations,
        ..._getImportOperationsForNotes(flowVersion, request),
    ]
}

export { _importFlow, _getImportOperationsForSteps as _getImportOperations }