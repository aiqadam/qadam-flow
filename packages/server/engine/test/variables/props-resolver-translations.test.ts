import { createServer, Server } from 'http'
import { LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import { FlowActionType, FlowTriggerType, FlowVersionState, GenericStepOutput, StepOutputStatus, StreamStepProgress } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { createPropsResolver } from '../../src/lib/variables/props-resolver'

const TRANSLATIONS = {
    translations: [
        { key: 'welcome.title', values: { en: 'Welcome', ru: 'Добро пожаловать' } },
        { key: 'greeting', values: { ru: 'Привет' } },
        { key: 'raw.value', values: { en: '{{connections[\'x\'].access_token}}' } },
    ],
}
const PROJECT = { defaultLocale: 'en' }

let server: Server
let apiUrl: string
const requestCounts = new Map<string, number>()

beforeAll(async () => {
    server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
        requestCounts.set(req.url ?? '', (requestCounts.get(req.url ?? '') ?? 0) + 1)
        if (req.url === '/v1/worker/translations') {
            res.end(JSON.stringify(TRANSLATIONS))
            return
        }
        if (req.url === '/v1/worker/project') {
            res.end(JSON.stringify(PROJECT))
            return
        }
        res.statusCode = 404
        res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('mock server failed to bind to a TCP port')
    }
    apiUrl = `http://127.0.0.1:${address.port}/`
})

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
})

function buildConstants(params: { localeSource?: string | null, inheritedRunLocale?: string | null, stepNames?: string[] } = {}): EngineConstants {
    return new EngineConstants({
        flowId: 'FLOW_ID',
        flowVersionId: 'FLOW_VERSION_ID',
        flowVersionState: FlowVersionState.LOCKED,
        triggerQadamName: 'trigger',
        flowRunId: 'FLOW_RUN_ID',
        publicApiUrl: 'http://127.0.0.1:1/api/',
        internalApiUrl: apiUrl,
        retryConstants: { maxAttempts: 1, retryExponential: 2, retryInterval: 1 },
        engineToken: 'WORKER_TOKEN',
        projectId: 'PROJECT_ID',
        streamStepProgress: StreamStepProgress.NONE,
        workerHandlerId: null,
        httpRequestId: null,
        platformId: 'PLATFORM_ID',
        stepNames: params.stepNames ?? ['trigger', 't'],
        flowVersionLocaleSource: params.localeSource ?? null,
        inheritedRunLocale: params.inheritedRunLocale ?? null,
    })
}

async function buildExecutionState(triggerOutput: Record<string, unknown> = {}): Promise<FlowExecutorContext> {
    return FlowExecutorContext.empty().upsertStep('trigger', GenericStepOutput.create({
        type: FlowTriggerType.PIECE,
        status: StepOutputStatus.SUCCEEDED,
        input: {},
        output: triggerOutput,
    }))
}

function buildResolver(constants: EngineConstants) {
    return createPropsResolver({
        projectId: constants.projectId,
        engineToken: constants.engineToken,
        apiUrl: constants.internalApiUrl,
        contextVersion: LATEST_CONTEXT_VERSION,
        stepNames: constants.stepNames,
        constants,
    })
}

describe('props-resolver: $t translations', () => {
    test('basic key resolves against the project default locale', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'welcome.title\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Welcome')
    })

    test('dynamic locale bracket picks the locale from the current step scope', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState({ lang: 'ru' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'welcome.title\'][trigger[\'output\'].lang]}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Добро пожаловать')
    })

    test('fallback chain: a base-language tag with no exact-tag value falls back to the base language', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState({ lang: 'ru-RU' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\'][trigger[\'output\'].lang]}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
    })

    test('missing key fails the resolve with TranslationKeyNotFoundError', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        await expect(buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'does.not.exist\']}}',
            executionState,
        })).rejects.toThrow('translation key (does.not.exist) not found')
    })

    test('an unresolvable step reference inside the locale bracket still throws', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        await expect(buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'welcome.title\'][unknownStep.lang]}}',
            executionState,
        })).rejects.toThrow('is not defined')
    })

    test('a translation value is inserted literally and never re-scanned for mustache syntax', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'raw.value\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('{{connections[\'x\'].access_token}}')
    })

    // A step literally named `t` (not `$t`) must resolve through the ordinary step-reference path,
    // unaffected by the `$t` root check (`variableName.startsWith('$t')` requires the dollar sign).
    test('a step named "t" resolves normally and is not treated as the translations root', async () => {
        const constants = buildConstants({ stepNames: ['trigger', 't'] })
        let executionState = await buildExecutionState()
        executionState = await executionState.upsertStep('t', GenericStepOutput.create({
            type: FlowActionType.PIECE,
            status: StepOutputStatus.SUCCEEDED,
            input: {},
            output: { value: 'plain-step' },
        }))
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{t[\'output\'].value}}',
            executionState,
        })
        expect(resolvedInput).toEqual('plain-step')
    })

    test('__proto__ as a key is an ordinary miss, never a prototype lookup', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        await expect(buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'__proto__\']}}',
            executionState,
        })).rejects.toThrow('translation key (__proto__) not found')
    })

    test('__proto__ as a dynamic locale is rejected by canonicalization and falls through to the default locale', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState({ lang: '__proto__' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'welcome.title\'][trigger[\'output\'].lang]}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Welcome')
    })

    test('an inherited run locale is used when the flow has no localeSource of its own', async () => {
        const constants = buildConstants({ inheritedRunLocale: 'ru' })
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
    })

    test('a fallback to a less-specific locale warns exactly once per (key, locale) per run', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const constants = buildConstants()
        const executionState = await buildExecutionState({ lang: 'ru-RU' })
        await buildResolver(constants).resolve({ unresolvedInput: '{{$t[\'greeting\'][trigger[\'output\'].lang]}}', executionState })
        await buildResolver(constants).resolve({ unresolvedInput: '{{$t[\'greeting\'][trigger[\'output\'].lang]}}', executionState })
        const fallbackWarnings = warnSpy.mock.calls.filter(([message]) => typeof message === 'string' && message.includes('greeting'))
        expect(fallbackWarnings).toHaveLength(1)
        warnSpy.mockRestore()
    })

    test('a bare literal localeSource (no braces) is a fixed locale and wins over an inherited run locale', async () => {
        const constants = buildConstants({ localeSource: 'ru', inheritedRunLocale: 'en' })
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
    })

    // localeSource is a normal mention-capable field — resolved through the same
    // `resolveInputAsync` path as any other step input, not a raw-JS eval: a single whole-string
    // token (`{{trigger['output'].lang}}`) returns its resolved value directly.
    test('a template localeSource resolves through the normal props-resolver path', async () => {
        const constants = buildConstants({ localeSource: '{{trigger[\'output\'].lang}}', inheritedRunLocale: 'en' })
        const executionState = await buildExecutionState({ lang: 'ru' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
    })

    test('a localeSource that fails to evaluate falls back rather than failing the run', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const constants = buildConstants({ localeSource: '{{thisIsNotDefinedAnywhere}}', inheritedRunLocale: 'ru' })
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
        warnSpy.mockRestore()
    })

    test('a localeSource that resolves to a non-string falls back rather than failing the run', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const constants = buildConstants({ localeSource: '{{trigger[\'output\']}}', inheritedRunLocale: 'ru' })
        const executionState = await buildExecutionState({ lang: 'ru' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'greeting\']}}',
            executionState,
        })
        expect(resolvedInput).toEqual('Привет')
        warnSpy.mockRestore()
    })

    test('the whole translation table and the run locale are each fetched at most once per EngineConstants instance', async () => {
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        const resolver = buildResolver(constants)
        await resolver.resolve({ unresolvedInput: '{{$t[\'welcome.title\']}}', executionState })
        await resolver.resolve({ unresolvedInput: '{{$t[\'welcome.title\']}}', executionState })
        const secondTranslations = await constants.getTranslations()
        const firstTranslations = await constants.getTranslations()
        expect(secondTranslations).toBe(firstTranslations)
    })

    // A `$t` reached while `localeSource` is itself still resolving (directly, or nested inside a
    // formula) used to call back into `getRunLocale` while `runLocale` was still `undefined`,
    // recursing without bound. The `resolvingLocaleSource` flag threaded through that one
    // `resolveInputAsync` call breaks the cycle by reporting "no run locale yet" to that one
    // reentrant read — this only asserts the resolution terminates with a sane fallback; a
    // regression here manifests as the test hanging past its timeout (or a stack overflow), not
    // merely a wrong value.
    test('a $t nested inside localeSource resolves without recursing without bound', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const constants = buildConstants({ localeSource: '{{$t[\'welcome.title\']}}' })
        const executionState = await buildExecutionState()
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: '{{$t[\'welcome.title\']}}',
            executionState,
        })
        // The nested $t (reached while localeSource resolves) sees no run locale yet, so it falls
        // through to the project default ('en'), resolving to 'Welcome' — a string that is not
        // itself a valid BCP-47 tag, so localeSource's own resolution ends up `null` too. The outer
        // $t use then falls back to the same project default, landing on the same value.
        expect(resolvedInput).toEqual('Welcome')
        warnSpy.mockRestore()
    })

    // Multiple `$t` resolutions racing before the project/translations fetch lands (e.g. several
    // iterations of a CONCURRENT loop, each resolving a step input at roughly the same time) must
    // share ONE in-flight request per endpoint, not fire one each.
    test('N concurrent $t resolutions fetch the translation table and the project exactly once', async () => {
        const before = new Map(requestCounts)
        const constants = buildConstants()
        const executionState = await buildExecutionState()
        const resolver = buildResolver(constants)
        await Promise.all(Array.from({ length: 20 }, () =>
            resolver.resolve({ unresolvedInput: '{{$t[\'welcome.title\']}}', executionState }),
        ))
        const translationsDelta = (requestCounts.get('/v1/worker/translations') ?? 0) - (before.get('/v1/worker/translations') ?? 0)
        const projectDelta = (requestCounts.get('/v1/worker/project') ?? 0) - (before.get('/v1/worker/project') ?? 0)
        expect(translationsDelta).toBe(1)
        expect(projectDelta).toBe(1)
    })

    // The reentrancy guard must be scoped to localeSource's OWN evaluation, not to "any resolution
    // in flight on this EngineConstants instance" — a per-run flag set for the whole duration of
    // resolveRunLocaleOnce would also read null for every OTHER concurrent $t caller that merely
    // landed inside that same window, not just the one genuinely nested inside localeSource. A step
    // with several $t fields resolved through `applyFunctionToValues`'s own `Promise.all` is exactly
    // that case: only the FIRST field's call starts `resolveRunLocaleOnce` and would see the flag,
    // the other two arrive microtasks later while it is still pending. 'greeting' has only a 'ru'
    // value in the mock table (no 'en'), so a field that incorrectly resolved against a null run
    // locale (falling through to the 'en' project default) would throw TranslationKeyNotFoundError
    // instead of silently returning the wrong string — any wrong answer among the three fails this.
    test('a step with several $t fields resolved concurrently all resolve using the same run locale (not null for every field but the first)', async () => {
        const constants = buildConstants({ localeSource: '{{trigger[\'output\'].lang}}' })
        const executionState = await buildExecutionState({ lang: 'ru' })
        const { resolvedInput } = await buildResolver(constants).resolve({
            unresolvedInput: {
                a: '{{$t[\'greeting\']}}',
                b: '{{$t[\'greeting\']}}',
                c: '{{$t[\'greeting\']}}',
            },
            executionState,
        })
        expect(resolvedInput).toEqual({ a: 'Привет', b: 'Привет', c: 'Привет' })
    })

    // Same scoping concern, across separate `resolve()` calls sharing one `EngineConstants` — the
    // shape several CONCURRENT loop iterations resolving the same step input take.
    test('concurrent loop iterations each resolve $t using the same run locale, not null for every iteration but the first', async () => {
        const constants = buildConstants({ localeSource: '{{trigger[\'output\'].lang}}' })
        const executionState = await buildExecutionState({ lang: 'ru' })
        const resolver = buildResolver(constants)
        const results = await Promise.all(Array.from({ length: 5 }, () =>
            resolver.resolve({ unresolvedInput: '{{$t[\'greeting\']}}', executionState }),
        ))
        for (const { resolvedInput } of results) {
            expect(resolvedInput).toEqual('Привет')
        }
    })
})
