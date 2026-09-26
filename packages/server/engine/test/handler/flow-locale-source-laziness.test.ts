import { createServer, Server } from 'http'
import { FlowVersionState, StreamStepProgress } from '@aiqadam/shared'
import { EngineConstants } from '../../src/lib/handler/context/engine-constants'
import { FlowExecutorContext } from '../../src/lib/handler/context/flow-execution-context'
import { qadamExecutor } from '../../src/lib/handler/qadam-executor'
import { buildQadamAction } from './test-helper'

const TRANSLATIONS = {
    translations: [
        { key: 'greeting', values: { en: 'Hello', ru: 'Привет' } },
    ],
}
const PROJECT = { defaultLocale: 'en' }

let server: Server
let apiUrl: string

beforeAll(async () => {
    server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json')
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

function buildConstants(): EngineConstants {
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
        stepNames: ['trigger', 'step_1', 'step_2'],
        // References the very step that produces this value — only resolvable once `step_1` has
        // actually run, never at the moment `step_1` itself is being dispatched.
        flowVersionLocaleSource: '{{step_1[\'output\'].lang}}',
    })
}

describe('$t/localeSource laziness: a run-level context.run.locale() must not freeze the answer before the step it depends on has run', () => {
    it('resolves $t against step_1\'s real output in step_2, not against an empty context.run.locale() read made while step_1 itself was still running', async () => {
        const constants = buildConstants()

        // step_1 runs first, exactly the way a real flow dispatches steps in order. Building its
        // own `ActionContext` must not eagerly resolve `context.run.locale()` against step_1's own
        // (not-yet-existent) output — this action's own qadam never reads `context.run.locale()`
        // at all, so nothing should touch the run locale here regardless.
        const afterStep1 = (await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_1',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { lang: 'ru' } },
            }),
            executionState: FlowExecutorContext.empty(),
            constants,
        }))
        expect(afterStep1.steps.step_1.output).toEqual({ lang: 'ru' })

        // step_2 runs second, with step_1's real output now in scope — `localeSource` reads it for
        // the first time here, on the first actual consumer (`$t`), and must see `lang: 'ru'`.
        const afterStep2 = await qadamExecutor.handle({
            action: buildQadamAction({
                name: 'step_2',
                qadamName: '@aiqadam/qadam-data-mapper',
                actionName: 'advanced_mapping',
                input: { mapping: { key: '{{$t[\'greeting\']}}' } },
            }),
            executionState: afterStep1,
            constants,
        })

        expect(afterStep2.steps.step_2.output).toEqual({ key: 'Привет' })
    })
})
