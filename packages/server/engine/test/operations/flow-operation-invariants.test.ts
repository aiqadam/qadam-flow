import {
    ConnectionNotFoundError,
    EngineGenericError,
    EngineResponseStatus,
    ExecutionType,
    FlowActionType,
    FlowRunStatus,
    FlowTriggerType,
    FlowVersionState,
    ResumeReason,
    RunEnvironment,
    StepOutputStatus,
    StreamStepProgress,
} from '@aiqadam/shared'
import type { BeginExecuteFlowOperation, FlowAction, FlowVersion, ResumeExecuteFlowOperation } from '@aiqadam/shared'
import { describe, expect, it, vi } from 'vitest'

const { mockSendUpdate, mockBackup } = vi.hoisted(() => ({
    mockSendUpdate: vi.fn().mockResolvedValue(undefined),
    mockBackup: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/helper/flow-run-progress-reporter', () => ({
    flowRunProgressReporter: {
        sendUpdate: mockSendUpdate,
        backup: mockBackup,
        createOutputContext: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(undefined) }),
    },
}))

const { mockExecuteTrigger } = vi.hoisted(() => ({
    mockExecuteTrigger: vi.fn(),
}))
vi.mock('../../src/lib/helper/trigger-helper', () => ({
    triggerHelper: {
        executeTrigger: mockExecuteTrigger,
        executeOnStart: vi.fn().mockResolvedValue(undefined),
    },
}))

const { mockDownload, mockUpload } = vi.hoisted(() => ({
    mockDownload: vi.fn(),
    mockUpload: vi.fn(),
}))
vi.mock('../../src/lib/engine-file-api', () => ({
    engineFileApi: {
        download: mockDownload,
        upload: mockUpload,
    },
}))

const { mockSendFlowResponse } = vi.hoisted(() => ({
    mockSendFlowResponse: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/lib/worker-socket', () => ({
    workerSocket: {
        getWorkerClient: () => ({ sendFlowResponse: mockSendFlowResponse }),
    },
}))

const { mockCreateWaitpoint } = vi.hoisted(() => ({
    mockCreateWaitpoint: vi.fn(),
}))
vi.mock('../../src/lib/qadam-context/waitpoint-client', () => ({
    waitpointClient: {
        create: mockCreateWaitpoint,
    },
}))

import { flowOperation } from '../../src/lib/operations/flow.operation'

function makeFlowVersion(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-1',
        displayName: 'Test Flow',
        trigger: {
            name: 'trigger_1',
            valid: true,
            displayName: 'Test Trigger',
            type: FlowTriggerType.EMPTY,
            settings: {},
        },
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
}

function makeBeginOperation(overrides?: Partial<BeginExecuteFlowOperation>): BeginExecuteFlowOperation {
    return {
        projectId: 'proj-1',
        engineToken: 'test-token',
        internalApiUrl: 'http://localhost:3000/',
        publicApiUrl: 'http://localhost:4200/api/',
        timeoutInSeconds: 600,
        platformId: 'plat-1',
        flowVersion: makeFlowVersion(),
        flowRunId: 'run-1',
        executionType: ExecutionType.BEGIN,
        runEnvironment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: null,
        triggerPayload: { type: 'inline', value: {} },
        executeTrigger: false,
        ...overrides,
    }
}

function makeFlowVersionWithTwoApprovals(): FlowVersion {
    const step2: FlowAction = {
        name: 'step_2',
        displayName: 'Step 2 — Wait for Approval',
        type: FlowActionType.PIECE,
        skip: false,
        valid: true,
        settings: {
            input: {},
            qadamName: '@aiqadam/qadam-approval',
            qadamVersion: '1.0.0',
            actionName: 'wait_for_approval',
            propertySettings: {},
        },
    }
    const step1: FlowAction = {
        name: 'step_1',
        displayName: 'Step 1 — Wait for Approval',
        type: FlowActionType.PIECE,
        skip: false,
        valid: true,
        settings: {
            input: {},
            qadamName: '@aiqadam/qadam-approval',
            qadamVersion: '1.0.0',
            actionName: 'wait_for_approval',
            propertySettings: {},
            errorHandlingOptions: {
                continueOnFailure: { value: true },
                retryOnFailure: { value: false },
            },
        },
        nextAction: step2,
    }
    return {
        ...makeFlowVersion(),
        trigger: {
            name: 'trigger_1',
            valid: true,
            displayName: 'Test Trigger',
            type: FlowTriggerType.EMPTY,
            settings: {},
            nextAction: step1,
        },
    }
}

function makeResumeOperation(overrides?: Partial<ResumeExecuteFlowOperation>): ResumeExecuteFlowOperation {
    return {
        projectId: 'proj-1',
        engineToken: 'test-token',
        internalApiUrl: 'http://localhost:3000/',
        publicApiUrl: 'http://localhost:4200/api/',
        timeoutInSeconds: 600,
        platformId: 'plat-1',
        flowVersion: makeFlowVersion(),
        flowRunId: 'run-1',
        executionType: ExecutionType.RESUME,
        runEnvironment: RunEnvironment.TESTING,
        workerHandlerId: null,
        httpRequestId: null,
        streamStepProgress: StreamStepProgress.NONE,
        stepNameToTest: null,
        resumePayload: { type: 'inline', value: { data: {} } },
        resumeReason: ResumeReason.WAITPOINT,
        logsFileId: 'logs-file-1',
        ...overrides,
    }
}

describe('flow operation invariants', () => {
    describe('RESUME execution state hydration', () => {
        it('throws EngineGenericError when RESUME has empty execution state in logs file', async () => {
            mockDownload.mockReset()
            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({ executionState: { steps: {}, tags: [] } })),
            )

            const operation = makeResumeOperation()

            await expect(flowOperation.execute(operation)).rejects.toThrow(EngineGenericError)
            await expect(flowOperation.execute(operation)).rejects.toThrow('RESUME operation received with empty execution state')
        })

        it('throws when logsFileId is missing on RESUME', async () => {
            mockDownload.mockReset()
            const operation = makeResumeOperation({ logsFileId: undefined })

            await expect(flowOperation.execute(operation)).rejects.toThrow(EngineGenericError)
            await expect(flowOperation.execute(operation)).rejects.toThrow('logsFileId is missing for RESUME operation')
        })

        it('throws when executionState is missing in logs file', async () => {
            mockDownload.mockReset()
            mockDownload.mockResolvedValue(new TextEncoder().encode(JSON.stringify({})))

            const operation = makeResumeOperation()

            await expect(flowOperation.execute(operation)).rejects.toThrow(EngineGenericError)
            await expect(flowOperation.execute(operation)).rejects.toThrow('executionState is missing in logs file')
        })

        it('proceeds past hydration when logs file has non-empty execution state', async () => {
            mockDownload.mockReset()
            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation = makeResumeOperation()

            try {
                await flowOperation.execute(operation)
            }
            catch (e) {
                expect((e as Error).message).not.toContain('empty execution state')
                expect((e as Error).message).not.toContain('logsFileId is missing')
                expect((e as Error).message).not.toContain('executionState is missing')
            }
        })
    })

    describe('RESUME step-restoration semantics', () => {
        it('preserves FAILED steps on a waitpoint resume (resumePayload present)', async () => {
            // Regression for the Slack/webhook-resume bug: a FAILED step preserved by
            // `continueOnFailure` was being dropped from the restored journal on resume.
            // The engine then re-executed it from BEGIN, creating a fresh waitpoint and
            // (for Call Flow) re-invoking the subflow. That cascade is what eventually
            // let the global resumePayload pollute downstream paused steps.
            //
            // Setup: trigger → step_1 (FAILED with continueOnFailure) → step_2 (PAUSED waiting
            // for a webhook click). Resume is fired for step_2 with a non-null resumePayload
            // (waitpoint path). With the fix, step_1 stays FAILED in the restored state,
            // `isCompleted` short-circuits qadam-executor, and no new waitpoint is created.
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockCreateWaitpoint.mockResolvedValue({
                id: 'wp-new',
                resumeUrl: 'http://localhost:4200/api/v1/flow-runs/run-1/waitpoints/wp-new',
            })

            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                            step_1: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.FAILED,
                                input: {},
                                errorMessage: 'Subflow execution failed',
                            },
                            step_2: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.PAUSED,
                                input: {},
                                output: { approved: true },
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation: ResumeExecuteFlowOperation = {
                ...makeResumeOperation(),
                flowVersion: makeFlowVersionWithTwoApprovals(),
                resumePayload: {
                    type: 'inline',
                    value: { queryParams: { action: 'approve' }, body: {}, headers: {} },
                },
            }

            await flowOperation.execute(operation)

            expect(mockCreateWaitpoint).not.toHaveBeenCalled()
        })

        it('drops FAILED steps on a retry resume (resumeReason=RETRY — FlowRetryStrategy.FROM_FAILED_STEP)', async () => {
            // The retry-from-failed-step feature (flow-run-service.ts FlowRetryStrategy.FROM_FAILED_STEP)
            // re-enqueues the run as executionType=RESUME with resumeReason=RETRY, expecting the
            // engine to replay the failed step. Preserving FAILED on this path would silently turn
            // retry into a no-op. The discriminator is the explicit `resumeReason` field.
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockCreateWaitpoint.mockResolvedValue({
                id: 'wp-retry',
                resumeUrl: 'http://localhost:4200/api/v1/flow-runs/run-1/waitpoints/wp-retry',
            })

            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                            step_1: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.FAILED,
                                input: {},
                                errorMessage: 'transient error',
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation: ResumeExecuteFlowOperation = {
                ...makeResumeOperation(),
                flowVersion: makeFlowVersionWithTwoApprovals(),
                resumePayload: { type: 'inline', value: null },
                resumeReason: ResumeReason.RETRY,
            }

            await flowOperation.execute(operation)

            // step_1 (FAILED) was dropped because resumeReason=RETRY → engine replayed it from
            // BEGIN, which creates a waitpoint via the approval piece.
            expect(mockCreateWaitpoint).toHaveBeenCalled()
        })

        it('drops non-terminal statuses (e.g. RUNNING from a mid-step crash) on any resume', async () => {
            // Sanity check on the inverse direction: a step left in RUNNING (engine crash mid-step,
            // never reached a terminal status) should still be replayed on resume, regardless of
            // whether resumePayload is present. Only SUCCEEDED, PAUSED, and FAILED (the last
            // conditionally) survive restoration.
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockCreateWaitpoint.mockResolvedValue({
                id: 'wp-replay',
                resumeUrl: 'http://localhost:4200/api/v1/flow-runs/run-1/waitpoints/wp-replay',
            })

            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                            step_1: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.RUNNING,
                                input: {},
                            },
                            step_2: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.PAUSED,
                                input: {},
                                output: { approved: true },
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation: ResumeExecuteFlowOperation = {
                ...makeResumeOperation(),
                flowVersion: makeFlowVersionWithTwoApprovals(),
                resumePayload: {
                    type: 'inline',
                    value: { queryParams: { action: 'approve' }, body: {}, headers: {} },
                },
            }

            await flowOperation.execute(operation)

            expect(mockCreateWaitpoint).toHaveBeenCalledTimes(1)
        })

        it('preserves FAILED steps on a delay-piece waitpoint resume even though resumePayload is null', async () => {
            // The Delay piece's scheduled resume (`flow-run-module.ts` RESUME_DELAY_WAITPOINT
            // handler) calls `resumeFromWaitpoint` with `resumePayload: null`. Prior to the
            // explicit `resumeReason` field this looked indistinguishable from a retry, and the
            // engine would drop FAILED — replaying any `continueOnFailure` step that preceded
            // the delay. With `resumeReason: WAITPOINT`, FAILED is preserved correctly.
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockCreateWaitpoint.mockResolvedValue({
                id: 'wp-delay',
                resumeUrl: 'http://localhost:4200/api/v1/flow-runs/run-1/waitpoints/wp-delay',
            })

            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                            step_1: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.FAILED,
                                input: {},
                                errorMessage: 'Subflow execution failed',
                            },
                            step_2: {
                                type: FlowActionType.PIECE,
                                status: StepOutputStatus.PAUSED,
                                input: {},
                                output: {},
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation: ResumeExecuteFlowOperation = {
                ...makeResumeOperation(),
                flowVersion: makeFlowVersionWithTwoApprovals(),
                resumePayload: { type: 'inline', value: null },
                resumeReason: ResumeReason.WAITPOINT,
            }

            await flowOperation.execute(operation)

            expect(mockCreateWaitpoint).not.toHaveBeenCalled()
        })
    })

    describe('RESUME loop-iteration restoration', () => {
        // Blocking finding: `insertSuccessStepsOrPausedRecursively`'s nested-loop rebuild wrote
        // `newSteps[step] = newOutput` — a bracket assignment on a plain object built fresh per
        // iteration. `STEP_NAME_REGEX` admits `__proto__`, and it survives `ap_import_flow`
        // verbatim, so a LOOP step can legitimately contain a child named `__proto__`. Assigning to
        // that literal key does not create an own property — it invokes the inherited
        // `Object.prototype.__proto__` setter and reassigns the rebuilt iteration's own prototype
        // instead of storing the child's restored output, dropping it from
        // `Object.keys`/`Object.entries`/`JSON.stringify` on the next resume or log write. The
        // top-level restore (`getFlowExecutionState`'s `flowContext.upsertStep(step, newOutput)`)
        // already went through the fixed `upsertStep` before this change; only the nested rebuild
        // one level inside a loop was unguarded. Must fail (missing key, dropped by
        // `JSON.stringify`) on a bracket assignment and pass with `executionJournal.setOwnStep`.
        it('restores a paused loop iteration containing a step literally named "__proto__" as a real, JSON-visible key', async () => {
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockSendUpdate.mockClear()
            mockBackup.mockClear()

            const prototypeNamedStep = {
                type: FlowActionType.PIECE,
                status: StepOutputStatus.SUCCEEDED,
                input: {},
                output: { secret: 'value' },
            }
            // Computed key, not a literal `{ '__proto__': ... }` — object-literal syntax special-cases
            // the literal `__proto__` property name into a prototype assignment (per spec), which
            // would corrupt this *test fixture* before `JSON.stringify` ever ran and prove nothing.
            // A computed key goes through `CreateDataPropertyOrThrow`, giving the iteration record a
            // genuine own `"__proto__"` key — exactly what `JSON.parse` on a real persisted log
            // would also produce.
            const iterationRecord = { ['__proto__']: prototypeNamedStep }

            mockDownload.mockResolvedValue(
                new TextEncoder().encode(JSON.stringify({
                    executionState: {
                        steps: {
                            trigger_1: {
                                type: FlowTriggerType.EMPTY,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {},
                            },
                            loop_1: {
                                type: FlowActionType.LOOP_ON_ITEMS,
                                status: StepOutputStatus.SUCCEEDED,
                                input: {},
                                output: {
                                    item: 'x',
                                    index: 0,
                                    iterations: [iterationRecord],
                                },
                            },
                        },
                        tags: [],
                    },
                })),
            )

            const operation = makeResumeOperation()

            await flowOperation.execute(operation)

            const finalSendUpdate = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
            const restoredIteration = finalSendUpdate.flowExecutorContext.steps.loop_1.output.iterations[0]

            expect(Object.keys(restoredIteration)).toContain('__proto__')
            expect(JSON.parse(JSON.stringify(restoredIteration))).toHaveProperty('__proto__')
            expect(Object.getPrototypeOf(restoredIteration)).toBe(Object.prototype)
        })
    })

    describe('BEGIN payload hydration', () => {
        it('inline payload is forwarded without hitting the engine file client', async () => {
            mockDownload.mockReset()
            const operation = makeBeginOperation({
                triggerPayload: { type: 'inline', value: { hello: 'world' } },
            })

            try {
                await flowOperation.execute(operation)
            }
            catch {
                // downstream may fail; we only assert RPC call shape
            }

            expect(mockDownload).not.toHaveBeenCalled()
        })

        it('ref payload is fetched via the engine HTTP client', async () => {
            mockDownload.mockReset()
            mockDownload.mockResolvedValue(new TextEncoder().encode(JSON.stringify({ hello: 'ref' })))
            const operation = makeBeginOperation({
                triggerPayload: { type: 'ref', fileId: 'payload-file-1' },
            })

            try {
                await flowOperation.execute(operation)
            }
            catch {
                // downstream may fail; we only assert RPC call shape
            }

            expect(mockDownload).toHaveBeenCalledWith({
                apiUrl: 'http://localhost:3000/',
                engineToken: 'test-token',
                fileId: 'payload-file-1',
            })
        })
    })

    describe('trigger input resolution failure', () => {
        it('surfaces a USER ExecutionError from the trigger as a FAILED trigger step + OK engine response (instead of INTERNAL_ERROR)', async () => {
            mockSendUpdate.mockClear()
            mockBackup.mockClear()
            mockExecuteTrigger.mockRejectedValue(new ConnectionNotFoundError('missing-conn'))

            const triggerPayload = { headers: { 'x-source': 'webhook' }, body: { foo: 'bar' } }
            const operation = makeBeginOperation({
                triggerPayload: { type: 'inline', value: triggerPayload },
                executeTrigger: true,
            })

            const response = await flowOperation.execute(operation)

            expect(response.status).toBe(EngineResponseStatus.OK)

            const finalSendUpdate = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
            const finalCtx = finalSendUpdate.flowExecutorContext
            expect(finalCtx.verdict.status).toBe(FlowRunStatus.FAILED)
            expect(finalCtx.verdict.failedStep).toEqual({
                name: 'trigger_1',
                displayName: 'Test Trigger',
                message: expect.stringContaining('connection (missing-conn) not found'),
            })
            const triggerStep = finalCtx.steps.trigger_1
            expect(triggerStep.status).toBe(StepOutputStatus.FAILED)
            expect(triggerStep.errorMessage).toEqual(expect.stringContaining('connection (missing-conn) not found'))
            expect(triggerStep.output).toEqual(triggerPayload)
        })

        it('non-USER engine errors from the trigger still propagate (caller will map to INTERNAL_ERROR)', async () => {
            mockExecuteTrigger.mockRejectedValue(new EngineGenericError('SomeEngineFailure', 'boom'))
            const operation = makeBeginOperation({
                triggerPayload: { type: 'inline', value: {} },
                executeTrigger: true,
            })

            await expect(flowOperation.execute(operation)).rejects.toThrow(EngineGenericError)
        })
    })

    describe('trigger success output shape', () => {
        it('executeTrigger=true stores the run()-transformed first item as output', async () => {
            mockSendUpdate.mockClear()
            mockBackup.mockClear()
            const rawPayload = { body: { id: 42, raw: true } }
            const transformed = { id: 42, normalized: true }
            mockExecuteTrigger.mockResolvedValue({ output: [transformed] })

            const operation = makeBeginOperation({
                triggerPayload: { type: 'inline', value: rawPayload },
                executeTrigger: true,
            })

            const response = await flowOperation.execute(operation)
            expect(response.status).toBe(EngineResponseStatus.OK)

            const finalSendUpdate = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
            const triggerStep = finalSendUpdate.flowExecutorContext.steps.trigger_1
            expect(triggerStep.status).toBe(StepOutputStatus.SUCCEEDED)
            expect(triggerStep.output).toEqual(transformed)
        })

        it('executeTrigger=false stores the raw payload as output (no run() transformation)', async () => {
            mockSendUpdate.mockClear()
            mockBackup.mockClear()
            const rawPayload = { body: { id: 7 } }

            const operation = makeBeginOperation({
                triggerPayload: { type: 'inline', value: rawPayload },
                executeTrigger: false,
            })

            const response = await flowOperation.execute(operation)
            expect(response.status).toBe(EngineResponseStatus.OK)

            const finalSendUpdate = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
            const triggerStep = finalSendUpdate.flowExecutorContext.steps.trigger_1
            expect(triggerStep.status).toBe(StepOutputStatus.SUCCEEDED)
            expect(triggerStep.output).toEqual(rawPayload)
        })
    })

    describe('RESUME payload hydration', () => {
        it('resolves a ref resumePayload via the engine file client', async () => {
            mockDownload.mockReset()
            mockCreateWaitpoint.mockReset()
            mockDownload.mockImplementation(({ fileId }: { fileId: string }) => {
                if (fileId === 'logs-file-1') {
                    return Promise.resolve(new TextEncoder().encode(JSON.stringify({
                        executionState: {
                            steps: {
                                trigger_1: {
                                    type: FlowTriggerType.EMPTY,
                                    status: StepOutputStatus.SUCCEEDED,
                                    input: {},
                                    output: {},
                                },
                            },
                            tags: [],
                        },
                    })))
                }
                return Promise.resolve(new TextEncoder().encode(JSON.stringify({ resumed: 'from-ref' })))
            })

            const operation = makeResumeOperation({
                resumePayload: { type: 'ref', fileId: 'resume-file-1' },
            })

            try {
                await flowOperation.execute(operation)
            }
            catch {
                // downstream execution may fail; we only assert the resume payload was resolved
            }

            expect(mockDownload).toHaveBeenCalledWith({
                apiUrl: 'http://localhost:3000/',
                engineToken: 'test-token',
                fileId: 'resume-file-1',
            })
        })
    })

    describe('sync caller response on a terminal failure', () => {
        it('answers the waiting caller with a 500 rather than leaving it to time out', async () => {
            mockSendFlowResponse.mockClear()
            mockExecuteTrigger.mockRejectedValue(new ConnectionNotFoundError('missing-conn'))

            const operation = makeBeginOperation({
                executeTrigger: true,
                workerHandlerId: 'handler-1',
                httpRequestId: 'req-1',
            })

            await flowOperation.execute(operation)

            expect(mockSendFlowResponse).toHaveBeenCalledTimes(1)
            const sent = mockSendFlowResponse.mock.calls[0][0]
            expect(sent.workerHandlerId).toBe('handler-1')
            expect(sent.httpRequestId).toBe('req-1')
            expect(sent.runResponse.status).toBe(500)
            // No step names, no error text, no terminal status: the endpoint is reachable by
            // anyone holding the flow id.
            expect(sent.runResponse.body).toEqual({
                message: 'The flow run did not complete successfully.',
                runId: 'run-1',
            })
        })

        it('stays silent when no sync caller is waiting', async () => {
            mockSendFlowResponse.mockClear()
            mockExecuteTrigger.mockRejectedValue(new ConnectionNotFoundError('missing-conn'))

            await flowOperation.execute(makeBeginOperation({ executeTrigger: true }))

            expect(mockSendFlowResponse).not.toHaveBeenCalled()
        })

        it('stays silent on a run that succeeded', async () => {
            mockSendFlowResponse.mockClear()
            mockExecuteTrigger.mockReset()
            mockExecuteTrigger.mockResolvedValue({ output: [{ ok: true }] })

            const operation = makeBeginOperation({
                executeTrigger: true,
                workerHandlerId: 'handler-1',
                httpRequestId: 'req-1',
            })

            await flowOperation.execute(operation)

            const finalSendUpdate = mockSendUpdate.mock.calls[mockSendUpdate.mock.calls.length - 1][0]
            expect(finalSendUpdate.flowExecutorContext.verdict.status).not.toBe(FlowRunStatus.FAILED)
            expect(mockSendFlowResponse).not.toHaveBeenCalled()
        })

        it('never lets a failed publish break the run', async () => {
            mockSendFlowResponse.mockClear()
            mockSendFlowResponse.mockRejectedValueOnce(new Error('pubsub down'))
            mockExecuteTrigger.mockRejectedValue(new ConnectionNotFoundError('missing-conn'))

            const operation = makeBeginOperation({
                executeTrigger: true,
                workerHandlerId: 'handler-1',
                httpRequestId: 'req-1',
            })

            const response = await flowOperation.execute(operation)

            expect(response.status).toBe(EngineResponseStatus.OK)
        })
    })
})
