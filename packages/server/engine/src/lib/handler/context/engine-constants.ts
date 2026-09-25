import { ContextVersion } from '@aiqadam/qadams-framework'
import { BeginExecuteFlowOperation, DEFAULT_EXECUTE_PROPERTY_RUN_ID, DEFAULT_MCP_DATA, DEFAULT_TRIGGER_EXECUTION_RUN_ID, EngineGenericError, ExecutePropsOptions, ExecuteToolOperation, ExecuteTriggerOperation, ExecutionState, ExecutionType, flowStructureUtil, FlowVersionState, isNil, isString, localeUtil, PlatformId, Project, ProjectId, ResumeExecuteFlowOperation, ResumePayload, RunEnvironment, StreamStepProgress, TriggerHookType, tryCatch } from '@aiqadam/shared'
import { logRedaction, StepLogPolicy } from '../../helper/log-redaction'
import { createTranslationResolver } from '../../qadam-context/translation-resolver'
import { createPropsResolver, PropsResolver, resolveInputAsync } from '../../variables/props-resolver'
import type { FlowExecutorContext } from './flow-execution-context'

type RetryConstants = {
    maxAttempts: number
    retryExponential: number
    retryInterval: number
}

type EngineConstantsParams = {
    flowId: string
    flowVersionId: string
    flowVersionState: FlowVersionState
    triggerQadamName: string
    flowRunId: string
    publicApiUrl: string
    internalApiUrl: string
    retryConstants: RetryConstants
    engineToken: string
    projectId: ProjectId
    streamStepProgress: StreamStepProgress
    workerHandlerId: string | null
    httpRequestId: string | null
    resumePayload?: ResumePayload
    runEnvironment?: RunEnvironment
    stepNameToTest?: string
    logsFileId?: string
    timeoutInSeconds: number
    platformId: PlatformId
    stepNames: string[]
    stepLogPolicy?: Map<string, StepLogPolicy>
    isInlineChild?: boolean
    inlineDepth?: number
    // When this execution's `timeoutInSeconds` budget started. An inline child shares its parent's.
    executionStartedAt?: number
    // An inline child called from an iteration of a concurrent loop: its own loops run one item at a
    // time, as a loop nested in that iteration would, so nesting cannot multiply the operator ceiling.
    insideConcurrentIteration?: boolean
    // `FlowVersion.localeSource` — an expression evaluated once, lazily, to pick this run's own
    // translation locale (see `EngineConstants#getRunLocale`). `null`/absent means the run has no
    // override of its own and falls back to `inheritedRunLocale`, then the project's default.
    flowVersionLocaleSource?: string | null
    // The parent run's resolved locale, for a subflow (inline or queued `callFlow`). Only consulted
    // when this run's own `flowVersionLocaleSource` does not resolve to anything usable.
    inheritedRunLocale?: string | null
}

const DEFAULT_RETRY_CONSTANTS: RetryConstants = {
    maxAttempts: 4,
    retryExponential: 2,
    retryInterval: 2000,
}

export class EngineConstants {
    public static readonly BASE_CODE_DIRECTORY = process.env.AP_BASE_CODE_DIRECTORY ?? './codes'
    public static readonly INPUT_FILE = './input.json'
    public static readonly OUTPUT_FILE = './output.json'
    public static readonly DEV_QADAMS = (process.env.AP_DEV_QADAMS ?? process.env.AP_DEV_PIECES)?.split(',') ?? []
    public static readonly TEST_MODE = process.env.AP_TEST_MODE === 'true'

    public readonly platformId: string
    public readonly timeoutInSeconds: number
    public readonly flowId: string
    public readonly flowVersionId: string
    public readonly flowVersionState: FlowVersionState
    public readonly triggerQadamName: string
    public readonly flowRunId: string
    public readonly publicApiUrl: string
    public readonly internalApiUrl: string
    public readonly retryConstants: RetryConstants
    public readonly engineToken: string
    public readonly projectId: ProjectId
    public readonly streamStepProgress: StreamStepProgress
    public readonly workerHandlerId: string | null
    public readonly httpRequestId: string | null
    public readonly resumePayload?: ResumePayload
    public readonly runEnvironment?: RunEnvironment
    public readonly stepNameToTest?: string
    public readonly logsFileId?: string
    public readonly stepNames: string[] = []
    public readonly stepLogPolicy: Map<string, StepLogPolicy>
    public readonly isInlineChild: boolean
    public readonly inlineDepth: number
    public readonly executionStartedAt: number
    public readonly insideConcurrentIteration: boolean
    public readonly flowVersionLocaleSource: string | null
    public readonly inheritedRunLocale: string | null
    private project: Project | null = null
    // The in-flight fetch, memoized separately from the resolved value: multiple `$t` resolutions
    // (or step contexts) racing before the first fetch lands must all await the SAME promise
    // rather than each firing their own request — cleared on rejection so a transient failure
    // isn't cached forever.
    private projectPromise: Promise<Project> | undefined = undefined
    // A `Map` throughout, never a plain object: a translation key or locale tag equal to
    // `__proto__`/`constructor` must be an ordinary entry, not a prototype lookup.
    private translations: Map<string, Map<string, string>> | null = null
    private translationsPromise: Promise<Map<string, Map<string, string>>> | undefined = undefined
    // `undefined` = not yet resolved this run; `null` = resolved to "no override". Evaluated once
    // per run, lazily, on the first `$t` (or subflow dispatch) that needs it.
    private runLocale: string | null | undefined = undefined
    private runLocalePromise: Promise<string | null> | undefined = undefined
    // Set for the duration of the one resolution attempt that owns `runLocalePromise`, so a `$t`
    // (or a formula wrapping one) reached from *inside* `localeSource`'s own evaluation sees "no
    // run locale yet" instead of awaiting a promise that depends on itself (a hang, not a stack
    // overflow, since the recursion here is across `await` boundaries). This flag is coarser than
    // true call-stack reentrancy: a genuinely unrelated concurrent resolution (e.g. two CONCURRENT
    // loop iterations, one of which is the one resolving `localeSource` for the whole run) that
    // happens to land inside this same narrow window also reads `null` here, rather than awaiting
    // the shared promise. That is an accepted degraded answer — the same fallback a resolution
    // failure already produces (default locale, one warning) — for what is already a
    // self-referential `localeSource`; the alternative (a real hang) is not.
    private isResolvingRunLocale = false
    private warnedTranslationFallbacks = new Set<string>()

    public get isRunningApTests(): boolean {
        return EngineConstants.TEST_MODE
    }

    public get isTestFlow(): boolean {
        return this.streamStepProgress === StreamStepProgress.WEBSOCKET
    }

    public get baseCodeDirectory(): string {
        return EngineConstants.BASE_CODE_DIRECTORY
    }

    public get devQadams(): string[] {
        return EngineConstants.DEV_QADAMS
    }

    public constructor(params: EngineConstantsParams) {
        if (!params.publicApiUrl.endsWith('/api/')) {
            throw new EngineGenericError('PublicUrlNotEndsWithSlashError', `Public URL must end with a slash, got: ${params.publicApiUrl}`)
        }
        if (!params.internalApiUrl.endsWith('/')) {
            throw new EngineGenericError('InternalApiUrlNotEndsWithSlashError', `Internal API URL must end with a slash, got: ${params.internalApiUrl}`)
        }

        this.flowId = params.flowId
        this.flowVersionId = params.flowVersionId
        this.flowVersionState = params.flowVersionState
        this.flowRunId = params.flowRunId
        this.publicApiUrl = params.publicApiUrl
        this.internalApiUrl = params.internalApiUrl
        this.retryConstants = params.retryConstants
        this.triggerQadamName = params.triggerQadamName
        this.engineToken = params.engineToken
        this.projectId = params.projectId
        this.streamStepProgress = params.streamStepProgress
        this.workerHandlerId = params.workerHandlerId
        this.httpRequestId = params.httpRequestId
        this.resumePayload = params.resumePayload
        this.runEnvironment = params.runEnvironment
        this.stepNameToTest = params.stepNameToTest
        this.logsFileId = params.logsFileId
        this.platformId = params.platformId
        this.timeoutInSeconds = params.timeoutInSeconds
        this.stepNames = params.stepNames
        this.stepLogPolicy = params.stepLogPolicy ?? new Map()
        this.isInlineChild = params.isInlineChild ?? false
        this.inlineDepth = params.inlineDepth ?? 0
        this.executionStartedAt = params.executionStartedAt ?? Date.now()
        this.insideConcurrentIteration = params.insideConcurrentIteration ?? false
        this.flowVersionLocaleSource = params.flowVersionLocaleSource ?? null
        this.inheritedRunLocale = params.inheritedRunLocale ?? null
    }
  
    public static fromExecuteFlowInput(input: ResolvedExecuteFlowOperation): EngineConstants {
        return new EngineConstants({
            flowId: input.flowVersion.flowId,
            flowVersionId: input.flowVersion.id,
            flowVersionState: input.flowVersion.state,
            triggerQadamName: input.flowVersion.trigger.settings.qadamName,
            flowRunId: input.flowRunId,
            publicApiUrl: input.publicApiUrl,
            internalApiUrl: input.internalApiUrl,
            retryConstants: DEFAULT_RETRY_CONSTANTS,
            engineToken: input.engineToken,
            projectId: input.projectId,
            streamStepProgress: input.streamStepProgress,
            workerHandlerId: input.workerHandlerId ?? null,
            httpRequestId: input.httpRequestId ?? null,
            resumePayload: input.executionType === ExecutionType.RESUME ? input.resumePayload : undefined,
            runEnvironment: input.runEnvironment,
            stepNameToTest: input.stepNameToTest ?? undefined,
            logsFileId: input.logsFileId,
            timeoutInSeconds: input.timeoutInSeconds,
            platformId: input.platformId,
            stepNames: flowStructureUtil.getAllSteps(input.flowVersion.trigger).map((step) => step.name),
            stepLogPolicy: logRedaction.buildStepLogPolicy({ trigger: input.flowVersion.trigger }),
            flowVersionLocaleSource: input.flowVersion.localeSource,
            inheritedRunLocale: input.inheritedRunLocale,
        })
    }

    public static fromExecuteActionInput(input: ExecuteToolOperation): EngineConstants {
        return new EngineConstants({
            flowId: DEFAULT_MCP_DATA.flowId,
            flowVersionId: DEFAULT_MCP_DATA.flowVersionId,
            flowVersionState: DEFAULT_MCP_DATA.flowVersionState,
            triggerQadamName: DEFAULT_MCP_DATA.triggerQadamName,
            flowRunId: DEFAULT_MCP_DATA.flowRunId,
            publicApiUrl: input.publicApiUrl,
            internalApiUrl: addTrailingSlashIfMissing(input.internalApiUrl),
            retryConstants: DEFAULT_RETRY_CONSTANTS,
            engineToken: input.engineToken,
            projectId: input.projectId,
            streamStepProgress: StreamStepProgress.NONE,
            workerHandlerId: null,
            httpRequestId: null,
            resumePayload: undefined,
            runEnvironment: undefined,
            stepNameToTest: undefined,
            timeoutInSeconds: input.timeoutInSeconds,
            platformId: input.platformId,
            stepNames: [],
        })
    }

    public static fromExecutePropertyInput(input: Omit<ExecutePropsOptions, 'qadam'> & { qadamName: string, qadamVersion: string }): EngineConstants {
        return new EngineConstants({
            flowId: input.flowVersion?.flowId ?? DEFAULT_MCP_DATA.flowId,
            flowVersionId: input.flowVersion?.id ?? DEFAULT_MCP_DATA.flowVersionId,
            flowVersionState: input.flowVersion?.state ?? DEFAULT_MCP_DATA.flowVersionState,
            triggerQadamName: input.flowVersion?.trigger?.settings.qadamName ?? DEFAULT_MCP_DATA.triggerQadamName,
            flowRunId: DEFAULT_EXECUTE_PROPERTY_RUN_ID,
            publicApiUrl: input.publicApiUrl,
            internalApiUrl: addTrailingSlashIfMissing(input.internalApiUrl),
            retryConstants: DEFAULT_RETRY_CONSTANTS,
            engineToken: input.engineToken,
            projectId: input.projectId,
            streamStepProgress: StreamStepProgress.NONE,
            workerHandlerId: null,
            httpRequestId: null,
            resumePayload: undefined,
            runEnvironment: undefined,
            stepNameToTest: undefined,
            timeoutInSeconds: input.timeoutInSeconds,
            platformId: input.platformId,
            stepNames: input.flowVersion?.trigger ? flowStructureUtil.getAllSteps(input.flowVersion.trigger).map((step) => step.name) : [],
            stepLogPolicy: input.flowVersion?.trigger ? logRedaction.buildStepLogPolicy({ trigger: input.flowVersion.trigger }) : new Map(),
        })
    }

    public static fromExecuteTriggerInput(input: ResolvedExecuteTriggerOperation<TriggerHookType>): EngineConstants {
        return new EngineConstants({
            flowId: input.flowVersion.flowId,
            flowVersionId: input.flowVersion.id,
            flowVersionState: input.flowVersion.state,
            triggerQadamName: input.flowVersion.trigger.settings.qadamName,
            flowRunId: DEFAULT_TRIGGER_EXECUTION_RUN_ID,
            publicApiUrl: input.publicApiUrl,
            internalApiUrl: addTrailingSlashIfMissing(input.internalApiUrl),
            retryConstants: DEFAULT_RETRY_CONSTANTS,
            engineToken: input.engineToken,
            projectId: input.projectId,
            streamStepProgress: StreamStepProgress.NONE,
            workerHandlerId: null,
            httpRequestId: null,
            resumePayload: undefined,
            runEnvironment: undefined,
            stepNameToTest: undefined,
            timeoutInSeconds: input.timeoutInSeconds,
            platformId: input.platformId,
            stepNames: flowStructureUtil.getAllSteps(input.flowVersion.trigger).map((step) => step.name),
            stepLogPolicy: logRedaction.buildStepLogPolicy({ trigger: input.flowVersion.trigger }),
        })
    }
    public getPropsResolver(contextVersion: ContextVersion | undefined): PropsResolver {
        return createPropsResolver({
            projectId: this.projectId,
            engineToken: this.engineToken,
            apiUrl: this.internalApiUrl,
            contextVersion,
            stepNames: this.stepNames,
            constants: this,
        })
    }
    private async getProject(): Promise<Project> {
        if (this.project) {
            return this.project
        }
        if (isNil(this.projectPromise)) {
            this.projectPromise = this.fetchProjectOnce()
        }
        return this.projectPromise
    }

    private async fetchProjectOnce(): Promise<Project> {
        try {
            const getWorkerProjectEndpoint = `${this.internalApiUrl}v1/worker/project`

            const response = await fetch(getWorkerProjectEndpoint, {
                headers: {
                    Authorization: `Bearer ${this.engineToken}`,
                },
            })

            this.project = await response.json() as Project
            return this.project
        }
        catch (error) {
            this.projectPromise = undefined
            throw error
        }
    }

    public externalProjectId = async (): Promise<string | undefined> => {
        const project = await this.getProject()
        return project.externalId ?? undefined
    }

    public async getProjectDefaultLocale(): Promise<string | null> {
        const project = await this.getProject()
        return project.defaultLocale ?? null
    }

    // The whole project translation table, fetched once per run and lazily — only on the first
    // `$t` this run actually resolves. Never re-fetched across a resume: a resumed run gets a fresh
    // `EngineConstants` instance, so this is "no cross-run cache" by construction, not by policy.
    public async getTranslations(): Promise<Map<string, Map<string, string>>> {
        if (!isNil(this.translations)) {
            return this.translations
        }
        if (isNil(this.translationsPromise)) {
            this.translationsPromise = this.fetchTranslationsOnce()
        }
        return this.translationsPromise
    }

    private async fetchTranslationsOnce(): Promise<Map<string, Map<string, string>>> {
        try {
            const rows = await createTranslationResolver({ engineToken: this.engineToken, apiUrl: this.internalApiUrl }).obtainAll()
            const translations = new Map<string, Map<string, string>>()
            for (const row of rows) {
                translations.set(row.key, new Map(Object.entries(row.values)))
            }
            this.translations = translations
            return translations
        }
        catch (error) {
            this.translationsPromise = undefined
            throw error
        }
    }

    // One function, one memoized answer per run: this run's own `localeSource` (evaluated lazily
    // against whatever scope is available the first time it is needed) wins over the inherited
    // parent locale, which wins over "no override" (the caller then falls back to the project's
    // `defaultLocale`). A `localeSource` that fails to evaluate to a usable locale is logged once
    // and treated as absent — it never fails the run.
    public async getRunLocale(params: { executionState: FlowExecutorContext }): Promise<string | null> {
        if (this.runLocale !== undefined) {
            return this.runLocale
        }
        // Checked BEFORE the in-flight-promise memoization below, not after: once
        // `resolveRunLocaleOnce`'s promise is assigned, a nested `$t` reached from inside its own
        // `resolveOwnLocaleSource` call would otherwise be handed that exact same promise and
        // await it — a promise awaiting itself, which hangs forever rather than throwing. See the
        // field's own comment for the accepted false-positive this flag can also produce.
        if (this.isResolvingRunLocale) {
            return null
        }
        if (isNil(this.runLocalePromise)) {
            this.runLocalePromise = this.resolveRunLocaleOnce(params.executionState)
        }
        return this.runLocalePromise
    }

    private async resolveRunLocaleOnce(executionState: FlowExecutorContext): Promise<string | null> {
        this.isResolvingRunLocale = true
        try {
            const ownLocale = await this.resolveOwnLocaleSource(executionState)
            this.runLocale = ownLocale ?? this.inheritedRunLocale
            return this.runLocale
        }
        catch (error) {
            this.runLocalePromise = undefined
            throw error
        }
        finally {
            this.isResolvingRunLocale = false
        }
    }

    // `localeSource` is a normal mention-capable field — `{{trigger['output'].lang}}` — resolved
    // through the same `resolveInputAsync` path every other step input goes through (a single
    // whole-string token returns its raw resolved value; a bare literal like `ru`, no braces,
    // passes through unchanged and means a fixed locale), uncensored. Both a thrown resolution
    // error and a resolvable-but-unusable result (non-string, empty, non-canonical) fall back to
    // the inherited/default locale with one warning — this must never fail the run.
    //
    // The scope is built from every step name this run has, not just the ones the *outer* `$t`
    // expression happens to mention: `localeSource` is evaluated independently of whatever
    // triggered its first lookup, so it needs its own state regardless of the caller's own
    // referenced-step set.
    private async resolveOwnLocaleSource(executionState: FlowExecutorContext): Promise<string | null> {
        const expression = this.flowVersionLocaleSource
        if (isNil(expression) || expression.trim().length === 0) {
            return null
        }
        const currentState = await executionState.currentState(this.stepNames)
        const { data: resolved, error } = await tryCatch(() => resolveInputAsync({
            input: expression,
            currentState,
            engineToken: this.engineToken,
            projectId: this.projectId,
            apiUrl: this.internalApiUrl,
            censoredInput: false,
            stepNames: this.stepNames,
            constants: this,
            executionState,
            contextVersion: undefined,
        }))
        if (!isNil(error)) {
            this.warnTranslationFallbackOnce(`localeSource:${this.flowVersionId}`, `localeSource "${expression}" failed to evaluate (${error instanceof Error ? error.message : String(error)}); falling back to the inherited or default locale`)
            return null
        }
        const canonical = isString(resolved) && resolved.length > 0 ? localeUtil.canonicalize(resolved) : null
        if (isNil(canonical)) {
            this.warnTranslationFallbackOnce(`localeSource:${this.flowVersionId}`, `localeSource "${expression}" did not resolve to a usable locale; falling back to the inherited or default locale`)
        }
        return canonical
    }

    public warnTranslationFallbackOnce(dedupeKey: string, message: string): void {
        if (this.warnedTranslationFallbacks.has(dedupeKey)) {
            return
        }
        this.warnedTranslationFallbacks.add(dedupeKey)
        // No per-step warnings channel exists on `FlowExecutorContext` today — the engine log is
        // the fallback this repo's engine conventions point to (see `evalInScope`'s own
        // `console.warn`, the only precedent for a non-fatal resolution issue).
        console.warn(`[translation] ${message}`)
    }
}


const addTrailingSlashIfMissing = (url: string): string => {
    return url.endsWith('/') ? url : url + '/'
}

export type ResolvedBeginExecuteFlowOperation = Omit<BeginExecuteFlowOperation, 'triggerPayload'> & {
    triggerPayload: unknown
}

export type ResolvedExecuteTriggerOperation<HT extends TriggerHookType> = Omit<ExecuteTriggerOperation<HT>, 'triggerPayload'> & {
    triggerPayload?: unknown
}

export type ResolvedResumeExecuteFlowOperation = Omit<ResumeExecuteFlowOperation, 'resumePayload'> & {
    resumePayload: ResumePayload
    executionState: ExecutionState
}

export type ResolvedExecuteFlowOperation = ResolvedBeginExecuteFlowOperation | ResolvedResumeExecuteFlowOperation
