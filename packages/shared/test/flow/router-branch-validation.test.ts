import {
    BranchExecutionType,
    BranchOperator,
    FlowActionType,
    flowOperations,
    FlowOperationType,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    flowStructureUtil,
    RouterAction,
    RouterActionSettings,
    RouterActionSettingsWithValidation,
    RouterExecutionType,
} from '../../src'

const CONDITION = {
    operator: BranchOperator.TEXT_EXACTLY_MATCHES,
    firstValue: '{{trigger[\'output\'].stage}}',
    secondValue: 'create_start',
    caseSensitive: false,
}

function buildRouterSettings(branches: RouterActionSettings['branches']): RouterActionSettings {
    return {
        branches,
        executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
    }
}

function buildFlowVersion(router: RouterAction): FlowVersion {
    return {
        id: 'flow-version-id',
        created: '2026-05-02T00:00:00.000Z',
        updated: '2026-05-02T00:00:00.000Z',
        flowId: 'flow-id',
        displayName: 'router flow',
        valid: true,
        schemaVersion: null,
        state: FlowVersionState.DRAFT,
        updatedBy: null,
        connectionIds: [],
        agentIds: [],
        notes: [],
        trigger: {
            name: 'trigger',
            type: FlowTriggerType.EMPTY,
            displayName: 'trigger',
            valid: true,
            settings: {},
            nextAction: router,
        },
    }
}

function buildRouter({ branches, valid }: { branches: RouterActionSettings['branches'], valid: boolean }): RouterAction {
    return {
        name: 'router',
        displayName: 'router',
        type: FlowActionType.ROUTER,
        valid,
        settings: buildRouterSettings(branches),
        children: branches.map(() => null),
    }
}

const FALLBACK_BRANCH = { branchType: BranchExecutionType.FALLBACK, branchName: 'Otherwise' } as const

describe('router branch validation', () => {
    it('rejects a condition branch whose condition group is empty', () => {
        const settings = buildRouterSettings([
            { conditions: [[]], branchType: BranchExecutionType.CONDITION, branchName: 'Branch 1' },
            FALLBACK_BRANCH,
        ])

        expect(RouterActionSettingsWithValidation.safeParse(settings).success).toBe(false)
    })

    it('rejects a condition branch with no condition groups at all', () => {
        const settings = buildRouterSettings([
            { conditions: [], branchType: BranchExecutionType.CONDITION, branchName: 'Branch 1' },
            FALLBACK_BRANCH,
        ])

        expect(RouterActionSettingsWithValidation.safeParse(settings).success).toBe(false)
    })

    it('accepts a condition branch that carries a real condition', () => {
        const settings = buildRouterSettings([
            { conditions: [[CONDITION]], branchType: BranchExecutionType.CONDITION, branchName: 'create_start' },
            FALLBACK_BRANCH,
        ])

        expect(RouterActionSettingsWithValidation.safeParse(settings).success).toBe(true)
    })

    it('accepts a router that carries nothing but a fallback branch', () => {
        expect(RouterActionSettingsWithValidation.safeParse(buildRouterSettings([FALLBACK_BRANCH])).success).toBe(true)
    })

    it('marks the router invalid when ADD_BRANCH inserts a branch with no conditions', () => {
        const flowVersion = buildFlowVersion(buildRouter({ branches: [FALLBACK_BRANCH], valid: true }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.ADD_BRANCH,
            request: {
                stepName: 'router',
                branchIndex: 0,
                branchName: 'Branch 1',
                conditions: [[]],
            },
        })

        expect(flowStructureUtil.getStep('router', updated.trigger)?.valid).toBe(false)
    })

    it('keeps the router valid when ADD_BRANCH inserts a conditioned branch', () => {
        const flowVersion = buildFlowVersion(buildRouter({ branches: [FALLBACK_BRANCH], valid: true }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.ADD_BRANCH,
            request: {
                stepName: 'router',
                branchIndex: 0,
                branchName: 'create_start',
                conditions: [[CONDITION]],
            },
        })

        expect(flowStructureUtil.getStep('router', updated.trigger)?.valid).toBe(true)
    })

    it('marks the router valid again once DELETE_BRANCH removes the condition-less branch', () => {
        const flowVersion = buildFlowVersion(buildRouter({
            branches: [
                { conditions: [[]], branchType: BranchExecutionType.CONDITION, branchName: 'Branch 1' },
                { conditions: [[CONDITION]], branchType: BranchExecutionType.CONDITION, branchName: 'create_start' },
                FALLBACK_BRANCH,
            ],
            valid: false,
        }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.DELETE_BRANCH,
            request: {
                stepName: 'router',
                branchIndex: 0,
            },
        })

        expect(flowStructureUtil.getStep('router', updated.trigger)?.valid).toBe(true)
    })

    it('marks an ADD_ACTION router invalid when the caller claims valid:true for a condition-less branch', () => {
        const flowVersion = buildFlowVersion(buildRouter({ branches: [FALLBACK_BRANCH], valid: true }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.ADD_ACTION,
            request: {
                parentStep: 'trigger',
                action: {
                    name: 'router_1',
                    displayName: 'Router',
                    type: FlowActionType.ROUTER,
                    valid: true,
                    settings: buildRouterSettings([
                        { conditions: [[]], branchType: BranchExecutionType.CONDITION, branchName: 'Branch 1' },
                        FALLBACK_BRANCH,
                    ]),
                },
            },
        })

        expect(flowStructureUtil.getStep('router_1', updated.trigger)?.valid).toBe(false)
    })

    it('keeps an ADD_ACTION router valid when the caller claims valid:true for a conditioned branch', () => {
        const flowVersion = buildFlowVersion(buildRouter({ branches: [FALLBACK_BRANCH], valid: true }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.ADD_ACTION,
            request: {
                parentStep: 'trigger',
                action: {
                    name: 'router_1',
                    displayName: 'Router',
                    type: FlowActionType.ROUTER,
                    valid: true,
                    settings: buildRouterSettings([
                        { conditions: [[CONDITION]], branchType: BranchExecutionType.CONDITION, branchName: 'create_start' },
                        FALLBACK_BRANCH,
                    ]),
                },
            },
        })

        expect(flowStructureUtil.getStep('router_1', updated.trigger)?.valid).toBe(true)
    })

    it('marks an IMPORT_FLOW router invalid when the import claims valid:true for a condition-less branch', () => {
        const flowVersion = buildFlowVersion(buildRouter({ branches: [FALLBACK_BRANCH], valid: true }))

        const updated = flowOperations.apply(flowVersion, {
            type: FlowOperationType.IMPORT_FLOW,
            request: {
                displayName: 'imported',
                trigger: {
                    name: 'trigger',
                    type: FlowTriggerType.EMPTY,
                    displayName: 'trigger',
                    valid: true,
                    settings: {},
                    lastUpdatedDate: '2026-05-02T00:00:00.000Z',
                    nextAction: buildRouter({
                        branches: [
                            { conditions: [[]], branchType: BranchExecutionType.CONDITION, branchName: 'Branch 1' },
                            FALLBACK_BRANCH,
                        ],
                        valid: true,
                    }),
                },
                schemaVersion: null,
                notes: null,
            },
        })

        expect(flowStructureUtil.getStep('router', updated.trigger)?.valid).toBe(false)
        expect(updated.valid).toBe(false)
    })
})
