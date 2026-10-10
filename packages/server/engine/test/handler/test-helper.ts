import { readFileSync } from 'fs'
import path from 'path'
import { ActionErrorHandlingOptions, BeginExecuteFlowOperation, BranchCondition, BranchExecutionType, CodeAction, ExecutionType, FlowAction, FlowActionType, FlowVersionState, LoopOnItemsAction, PieceAction, StreamStepProgress, PropertyExecutionType, RouterExecutionType, RunEnvironment, tryCatchSync } from '@aiqadam/shared'
import { EngineConstants, ResolvedBeginExecuteFlowOperation } from '../../src/lib/handler/context/engine-constants'

export const generateMockEngineConstants = (params?: Partial<EngineConstants>): EngineConstants => {
    return new EngineConstants(
        {
            platformId: params?.platformId ?? 'platformId',
            timeoutInSeconds: params?.timeoutInSeconds ?? 10,
            flowId: params?.flowId ?? 'flowId',
            flowVersionId: params?.flowVersionId ?? 'flowVersionId',
            flowVersionState: params?.flowVersionState ?? FlowVersionState.DRAFT,
            flowRunId: params?.flowRunId ?? 'flowRunId',
            publicApiUrl: params?.publicApiUrl ?? 'http://127.0.0.1:4200/api/',
            internalApiUrl: params?.internalApiUrl ?? 'http://127.0.0.1:3000/',
            retryConstants: params?.retryConstants ?? {
                maxAttempts: 2,
                retryExponential: 1,
                retryInterval: 1,
            },
            engineToken: params?.engineToken ?? 'engineToken',
            projectId: params?.projectId ?? 'projectId',
            triggerQadamName: params?.triggerQadamName ?? 'mcp-trigger-qadam-name',
            streamStepProgress: params?.streamStepProgress ?? StreamStepProgress.NONE,
            workerHandlerId: params?.workerHandlerId ?? null,
            httpRequestId: params?.httpRequestId ?? null,
            resumePayload: params?.resumePayload,
            runEnvironment: params?.runEnvironment ?? RunEnvironment.TESTING,
            stepNameToTest: params?.stepNameToTest ?? undefined,
            stepNames: params?.stepNames ?? [],
            stepLogPolicy: params?.stepLogPolicy,
            logsFileId: params?.logsFileId,
            executionStartedAt: params?.executionStartedAt,
            isInlineChild: params?.isInlineChild,
            insideConcurrentIteration: params?.insideConcurrentIteration,
        })
}

export function buildSimpleLoopAction({
    name,
    loopItems,
    firstLoopAction,
    skip,
}: {
    name: string
    loopItems: string
    firstLoopAction?: FlowAction
    skip?: boolean
}): LoopOnItemsAction {
    return {
        name,
        displayName: 'Loop',
        type: FlowActionType.LOOP_ON_ITEMS,
        skip: skip ?? false,
        settings: {
            items: loopItems,
        },
        firstLoopAction,
        valid: true,
    }
}

export function buildRouterWithOneCondition({ children, conditions, executionType, skip }: { children: FlowAction[], conditions: (BranchCondition | null)[], executionType: RouterExecutionType, skip?: boolean }): FlowAction {
    return {
        name: 'router',
        displayName: 'Your Router Name',
        type: FlowActionType.ROUTER,
        skip: skip ?? false,
        settings: {
            branches: conditions.map((condition) => {
                if (condition === null) {
                    return {
                        branchType: BranchExecutionType.FALLBACK,
                        branchName: 'Fallback Branch',
                    }
                }
                return {
                    conditions: [[condition]],
                    branchType: BranchExecutionType.CONDITION,
                    branchName: 'Test Branch',
                }
            }),
            executionType,
        },
        children,
        valid: true,
    }
}

export function buildCodeAction({ name, input, skip, nextAction, errorHandlingOptions }: { name: 'echo_step' | 'runtime' | 'echo_step_1' | 'system_error' | 'process_exit' | 'unhandled_rejection' | 'hello_world_npm' | 'stdout_on_failure' | 'setTimeout_error', input: Record<string, unknown>, skip?: boolean, errorHandlingOptions?: ActionErrorHandlingOptions, nextAction?: FlowAction }): CodeAction {
    return {
        name,
        displayName: 'Your Action Name',
        type: FlowActionType.CODE,
        skip: skip ?? false,
        settings: {
            input,
            sourceCode: {
                packageJson: '',
                code: '',
            },
            errorHandlingOptions,
        },
        nextAction,
        valid: true,
    }
}

// A step that runs the image's build pins the version the image carries: the loader no longer runs
// an exact pin on a build outside its caret range (#779). A qadam a test supplies through a mock
// has no build to read; the test says so with `isMockQadam`, and only then gets an arbitrary pin.
export function bundledQadamVersion({ qadamName, isMockQadam = false }: { qadamName: string, isMockQadam?: boolean }): string {
    if (isMockQadam) {
        return MOCK_QADAM_VERSION
    }
    const directory = qadamName.replace('@aiqadam/qadam-', '')
    for (const group of ['core', 'community']) {
        const version = readBundledVersion({ packageJsonPath: path.resolve(REPO_ROOT, 'packages/qadams', group, directory, 'package.json') })
        if (version !== null) {
            return version
        }
    }
    throw new Error(`No bundled qadam ${qadamName} in packages/qadams: build it, or pass isMockQadam for a mock`)
}

export function buildQadamAction({ name, input, skip, qadamName, actionName, nextAction, errorHandlingOptions, isMockQadam }: { errorHandlingOptions?: ActionErrorHandlingOptions, name: string, input: Record<string, unknown>, skip?: boolean, qadamName: string, actionName: string, nextAction?: FlowAction, isMockQadam?: boolean }): PieceAction {
    return {
        name,
        displayName: 'Your Action Name',
        type: FlowActionType.PIECE,
        skip: skip ?? false,
        settings: {
            input,
            qadamName,
            qadamVersion: bundledQadamVersion({ qadamName, isMockQadam }),
            actionName,
            propertySettings: Object.fromEntries(Object.entries(input).map(([key]) => [key, {
                type: PropertyExecutionType.MANUAL,
                schema: undefined,
            }])),
            errorHandlingOptions,
        },
        nextAction,
        valid: true,
    }
}

export function buildMockBeginExecuteFlowOperation(
    params: Partial<ResolvedBeginExecuteFlowOperation> & Pick<BeginExecuteFlowOperation, 'flowVersion'>,
): ResolvedBeginExecuteFlowOperation {
    return {
        projectId: 'projectId',
        engineToken: 'engineToken',
        internalApiUrl: 'http://127.0.0.1:3000/',
        publicApiUrl: 'http://127.0.0.1:4200/api/',
        timeoutInSeconds: 10,
        platformId: 'platformId',
        flowRunId: 'flowRunId',
        executionType: ExecutionType.BEGIN,
        runEnvironment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: null,
        triggerPayload: {},
        executeTrigger: false,
        ...params,
    }
}

const MOCK_QADAM_VERSION = '1.0.0'
// `test-helper.ts` sits at packages/server/engine/test/handler.
const REPO_ROOT = path.resolve(__dirname, '../../../../..')

// `null` only for a qadam that has no package.json in that group; any other failure is the test's
// environment being wrong and surfaces.
function readBundledVersion({ packageJsonPath }: { packageJsonPath: string }): string | null {
    const { data: content, error } = tryCatchSync<string, NodeJS.ErrnoException>(() => readFileSync(packageJsonPath, 'utf-8'))
    if (error !== null) {
        if (error.code === 'ENOENT') {
            return null
        }
        throw error
    }
    const packageJson: unknown = JSON.parse(content)
    if (typeof packageJson !== 'object' || packageJson === null || !('version' in packageJson) || typeof packageJson.version !== 'string') {
        throw new Error(`${packageJsonPath} has no version`)
    }
    return packageJson.version
}
