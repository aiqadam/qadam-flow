import {
    apId,
    FAIL_PARENT_ON_FAILURE_HEADER,
    FileType,
    FlowRun,
    FlowRunStatus,
    FlowStatus,
    JobPayload,
    PARENT_RUN_ID_HEADER,
    PauseType,
    ResumeExecuteFlowJobData,
    RunEnvironment,
    WebhookJobData,
} from '@aiqadam/shared'
import { Queue } from 'bullmq'
import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getPendingRunOwnerKey } from '../../../../src/app/database/redis/keys'
import { distributedStore, redisConnections } from '../../../../src/app/database/redis-connections'
import { fileService } from '../../../../src/app/file/file.service'
import { waitpointService } from '../../../../src/app/flows/flow-run/waitpoint/waitpoint-service'
import { domainHelper } from '../../../../src/app/helper/domain-helper'
import { WebhookFlowVersionToRun, webhookService } from '../../../../src/app/webhooks/webhook.service'
import { QueueName } from '../../../../src/app/workers/job'
import { createHandlers } from '../../../../src/app/workers/rpc/worker-rpc-service'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowRun, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// Mirrors `markParentRunAsFailed`'s `errorPayload` shape in `flow-runs-queue.ts` — parsing rather
// than casting the resolved (`unknown`-typed) resume payload into this shape.
const ResumeErrorPayload = z.object({
    body: z.object({
        status: z.string(),
        data: z.object({
            message: z.string(),
            link: z.string(),
        }),
    }),
})

async function waitForCondition({ fn, timeoutMs = 10000 }: WaitForConditionParams): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (await fn()) {
            return
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('waitForCondition timed out')
}

/**
 * The resumed job's own queue entry is id'd by the parent's flowRunId (`addToQueue`), the same
 * externally-observable handle `resume-flow-run.test.ts` reads a resume job back through.
 */
async function getResumeJobData(flowRunId: string): Promise<ResumeExecuteFlowJobData> {
    const queue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
    try {
        const job = await queue.getJob(flowRunId)
        if (!job) {
            throw new Error(`No queued resume job found for run ${flowRunId}`)
        }
        return ResumeExecuteFlowJobData.parse(job.data)
    }
    finally {
        await queue.close()
    }
}

/**
 * `addToQueue` always offloads a resume payload to a `WEBHOOK_PAYLOAD` file when no
 * `workerHandlerId` is attached (no live sync listener in this sandbox), so the job's own
 * `payload` field is a `ref`, never `inline`, for a plain async resume like this one.
 */
async function resolveResumePayload({ jobPayload, projectId }: ResolveResumePayloadParams): Promise<Record<string, unknown> | undefined> {
    if (jobPayload.type === 'inline') {
        return jobPayload.value
    }
    const { data } = await fileService(app!.log).getDataOrThrow({
        projectId,
        fileId: jobPayload.fileId,
        type: FileType.WEBHOOK_PAYLOAD,
    })
    return JSON.parse(data.toString('utf-8'))
}

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

/**
 * Exercises the exact production entry point (`webhookService.handleWebhook`, `async: false`) a
 * real sync webhook request hits, minus the HTTP layer — the fix lives in `flowRunService`, deep
 * downstream of the controller, so calling it directly here is equivalent for what these tests
 * check and doesn't need a live engine to answer. `onRunCreated` fires synchronously right after
 * the run row is created (`webhook-controller.ts`'s own draft routes rely on this too), well
 * before the handler starts waiting on `engineResponseWatcher` — a tiny `timeoutMs` just keeps
 * that wait from blocking the test for the full webhook timeout once nothing ever answers it in
 * this sandbox (no worker/engine runs these integration tests).
 */
async function callWebhookSync(params: {
    flowId: string
    parentRunId?: string
    failParentOnFailure?: boolean
    parentWaitpointId?: string
}): Promise<FlowRun | undefined> {
    let createdRun: FlowRun | undefined
    await webhookService.handleWebhook({
        flowId: params.flowId,
        async: false,
        saveSampleData: false,
        execute: true,
        flowVersionToRun: WebhookFlowVersionToRun.LOCKED_FALL_BACK_TO_LATEST,
        data: async () => ({ method: 'POST', headers: {}, body: {}, queryParams: {} }),
        logger: app!.log,
        parentRunId: params.parentRunId,
        failParentOnFailure: params.failParentOnFailure ?? false,
        parentWaitpointId: params.parentWaitpointId,
        onRunCreated: (run) => {
            createdRun = run
        },
        timeoutMs: 50,
    })
    return createdRun
}

async function createEnabledFlow(projectId: string): Promise<{ id: string }> {
    const flow = createMockFlow({ projectId, status: FlowStatus.ENABLED })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id })
    await db.save('flow_version', flowVersion)
    await db.update('flow', flow.id, { publishedVersionId: flowVersion.id })
    return flow
}

async function createPersistedRun(params: { projectId: string, status?: FlowRunStatus }): Promise<{ id: string }> {
    const flow = createMockFlow({ projectId: params.projectId, status: FlowStatus.ENABLED })
    await db.save('flow', flow)
    const flowVersion = createMockFlowVersion({ flowId: flow.id })
    await db.save('flow_version', flowVersion)
    const run = createMockFlowRun({
        projectId: params.projectId,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        status: params.status ?? FlowRunStatus.RUNNING,
        environment: RunEnvironment.PRODUCTION,
    })
    await db.save('flow_run', run)
    return run
}

/**
 * `handleAsync` enqueues under a freshly-minted `webhookRequestId`, echoed back on the response
 * as the `x-webhook-id` header — the only externally-observable handle for the job it created.
 * CE always resolves `getQueueName` to the single `QueueName.WORKER_JOBS` queue.
 */
async function getWebhookJobData(webhookRequestId: string): Promise<WebhookJobData> {
    const queue = new Queue(QueueName.WORKER_JOBS, { connection: await redisConnections.create() })
    try {
        const job = await queue.getJob(webhookRequestId)
        if (!job) {
            throw new Error(`No queued webhook job found for requestId ${webhookRequestId}`)
        }
        return WebhookJobData.parse(job.data)
    }
    finally {
        await queue.close()
    }
}

describe('Webhook ingress: parentRunId / failParentOnFailure verification (#521)', () => {
    describe('parentRunId project scoping', () => {
        it('drops both parentRunId and failParentOnFailure when the named parent belongs to another project', async () => {
            const { mockProject: projectA } = await mockAndSaveBasicSetup()
            const { mockProject: projectB } = await mockAndSaveBasicSetup()
            const flowInA = await createEnabledFlow(projectA.id)
            const foreignRun = await createPersistedRun({ projectId: projectB.id })

            const createdRun = await callWebhookSync({
                flowId: flowInA.id,
                parentRunId: foreignRun.id,
                failParentOnFailure: true,
            })

            expect(createdRun).toBeDefined()
            expect(createdRun?.parentRunId).toBeUndefined()
            expect(createdRun?.failParentOnFailure).toBe(false)
        })

        it('keeps a same-project parent whose row is already persisted', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: false,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
        })

        it('keeps a same-project parent that exists only as a pending run-owner record (parent row not flushed yet, #509)', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRunId = apId()
            await distributedStore.put(getPendingRunOwnerKey(parentRunId), { projectId: mockProject.id }, 600)

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId,
                failParentOnFailure: false,
            })

            expect(createdRun?.parentRunId).toBe(parentRunId)
        })
    })

    describe('failParentOnFailure waitpoint proof (impact item 3)', () => {
        it('keeps failParentOnFailure when the parent waitpoint proof matches a PENDING WEBHOOK waitpoint on that exact parent', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
                parentWaitpointId: waitpoint.id,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
            expect(createdRun?.failParentOnFailure).toBe(true)
        })

        it('drops failParentOnFailure (but keeps parentRunId) when no waitpoint proof is presented at all', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
            expect(createdRun?.failParentOnFailure).toBe(false)
        })

        it('drops failParentOnFailure when the presented waitpoint id does not belong to the named parent run', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            // A real PENDING WEBHOOK waitpoint — just not one that belongs to `parentRun`, the way
            // a value pulled out of thin air (or from some other run entirely) would look.
            const otherRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: otherRun.id,
                projectId: mockProject.id,
                callerRunId: otherRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
                parentWaitpointId: waitpoint.id,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
            expect(createdRun?.failParentOnFailure).toBe(false)
        })

        it('drops failParentOnFailure when the presented waitpoint already COMPLETED (pins the status: PENDING filter)', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })
            await waitpointService(app!.log).complete({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                waitpointId: waitpoint.id,
                resumePayload: { body: { status: 'success', data: {} } },
            })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
                parentWaitpointId: waitpoint.id,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
            expect(createdRun?.failParentOnFailure).toBe(false)
        })

        it('drops failParentOnFailure when the presented waitpoint is a DELAY waitpoint, not WEBHOOK (pins the type: WEBHOOK filter)', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'delayStep',
                type: PauseType.DELAY,
                version: 'V1',
                resumeDateTime: new Date(Date.now() + 60_000).toISOString(),
            })

            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
                parentWaitpointId: waitpoint.id,
            })

            expect(createdRun?.parentRunId).toBe(parentRun.id)
            expect(createdRun?.failParentOnFailure).toBe(false)
        })
    })

    /**
     * Everything above calls `webhookService.handleWebhook` directly with an already-resolved
     * `parentWaitpointId`, exercising `resolveParentAttachment`/`existsPendingWebhookWaitpoint`
     * but not the extraction that feeds them. These go through the real HTTP entry point
     * (`app.inject`, not `ctx.post` — this route is `securityAccess.public()` and takes no
     * bearer token, so `ctx.post`'s hardcoded `Authorization` header would be a caller identity
     * the real endpoint never sees) so `extractHeaderFromRequest` and its body-parse in
     * `webhook-request-converter.ts` run for real, on the exact `body: { data, callbackUrl }`
     * shape every already-published call-flow release sends. The async endpoint
     * (`/v1/webhooks/:flowId`, no `/sync`) is also the one call-flow actually calls, since it
     * waits for the callback rather than the HTTP response.
     */
    describe('HTTP-level: async webhook ingress reading the callbackUrl-derived proof for real', () => {
        it('persists the verified parentWaitpointId on the enqueued job from a real body callbackUrl + headers, no dedicated header involved', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })
            const callbackUrl = await domainHelper.getPublicApiUrl({
                path: `v1/flow-runs/${parentRun.id}/waitpoints/${waitpoint.id}`,
            })

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/webhooks/${flow.id}`,
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRun.id,
                    [FAIL_PARENT_ON_FAILURE_HEADER]: 'true',
                    'content-type': 'application/json',
                },
                payload: { data: { foo: 'bar' }, callbackUrl },
            })

            expect(response.statusCode).toBe(200)
            const webhookRequestId = response.headers['x-webhook-id']
            if (typeof webhookRequestId !== 'string') {
                throw new Error('Expected the x-webhook-id response header to be a string')
            }
            const jobData = await getWebhookJobData(webhookRequestId)
            expect(jobData.parentRunId).toBe(parentRun.id)
            expect(jobData.failParentOnFailure).toBe(true)
            expect(jobData.parentWaitpointId).toBe(waitpoint.id)
        })

        it('drops failParentOnFailure over HTTP when the callbackUrl names a different run than ap-parent-run-id', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const otherRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: otherRun.id,
                projectId: mockProject.id,
                callerRunId: otherRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })
            // Names `otherRun`'s own waitpoint, but the header claims `parentRun` as the parent —
            // a real call-flow request never produces this combination; this is what a forged
            // header from a third party (with a legitimate callbackUrl for a different run) would
            // look like.
            const callbackUrl = await domainHelper.getPublicApiUrl({
                path: `v1/flow-runs/${otherRun.id}/waitpoints/${waitpoint.id}`,
            })

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/webhooks/${flow.id}`,
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRun.id,
                    [FAIL_PARENT_ON_FAILURE_HEADER]: 'true',
                    'content-type': 'application/json',
                },
                payload: { data: { foo: 'bar' }, callbackUrl },
            })

            expect(response.statusCode).toBe(200)
            const webhookRequestId = response.headers['x-webhook-id']
            if (typeof webhookRequestId !== 'string') {
                throw new Error('Expected the x-webhook-id response header to be a string')
            }
            const jobData = await getWebhookJobData(webhookRequestId)
            expect(jobData.parentRunId).toBe(parentRun.id)
            expect(jobData.failParentOnFailure).toBe(false)
            expect(jobData.parentWaitpointId).toBeUndefined()
        })

        it('persists the verified parentWaitpointId when the callbackUrl is built with domainHelper.getInternalApiUrl, the form call-flow sends with internal: true', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)
            const parentRun = await createPersistedRun({ projectId: mockProject.id })
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })
            // `context.run.createWaitpoint({ internal: true })` builds its resume URL through
            // `domainHelper.getInternalApiUrl` rather than `getPublicApiUrl` — the extraction only
            // ever reads `url.pathname`, so it must not care which of the two built the URL.
            const callbackUrl = await domainHelper.getInternalApiUrl({
                path: `v1/flow-runs/${parentRun.id}/waitpoints/${waitpoint.id}`,
            })

            const response = await app!.inject({
                method: 'POST',
                url: `/api/v1/webhooks/${flow.id}`,
                headers: {
                    [PARENT_RUN_ID_HEADER]: parentRun.id,
                    [FAIL_PARENT_ON_FAILURE_HEADER]: 'true',
                    'content-type': 'application/json',
                },
                payload: { data: { foo: 'bar' }, callbackUrl },
            })

            expect(response.statusCode).toBe(200)
            const webhookRequestId = response.headers['x-webhook-id']
            if (typeof webhookRequestId !== 'string') {
                throw new Error('Expected the x-webhook-id response header to be a string')
            }
            const jobData = await getWebhookJobData(webhookRequestId)
            expect(jobData.parentRunId).toBe(parentRun.id)
            expect(jobData.failParentOnFailure).toBe(true)
            expect(jobData.parentWaitpointId).toBe(waitpoint.id)
        })
    })

    /**
     * A PRODUCTION run's row is owed by the runs-metadata queue (#509): `queueOrCreateInstantly`
     * hands `flowRun` (which already carries the verified `parentWaitpointId`) straight to
     * `runsMetadataQueue(log).add`, and only the drain's own `save()` actually writes the row.
     * That `add()` strips every field not on `RUNS_METADATA_UPSERT_KEYS` — if that
     * whitelist ever omits `parentWaitpointId`, a PRODUCTION child's proof is silently
     * dropped before it reaches Postgres, and `markParentRunAsFailed` (which reads the
     * *persisted* column, not the in-memory value `onRunCreated` sees) would find it NULL and
     * strand the parent forever. TESTING runs `save()` directly and never go through this path,
     * which is why this case needs a PRODUCTION run.
     */
    describe('Runs-metadata drain persists parentWaitpointId for PRODUCTION runs (#521)', () => {
        it('a PRODUCTION child persists parentWaitpointId through the drain, and a later failure completes the parent waitpoint with the error payload and resumes it', async () => {
            const { mockProject } = await mockAndSaveBasicSetup()
            const flow = await createEnabledFlow(mockProject.id)

            const parentFlow = createMockFlow({ projectId: mockProject.id })
            await db.save('flow', parentFlow)
            const parentFlowVersion = createMockFlowVersion({ flowId: parentFlow.id })
            await db.save('flow_version', parentFlowVersion)
            const parentRun = createMockFlowRun({
                projectId: mockProject.id,
                flowId: parentFlow.id,
                flowVersionId: parentFlowVersion.id,
                status: FlowRunStatus.PAUSED,
                environment: RunEnvironment.PRODUCTION,
            })
            await db.save('flow_run', parentRun)
            const { waitpoint } = await waitpointService(app!.log).createForPause({
                flowRunId: parentRun.id,
                projectId: mockProject.id,
                callerRunId: parentRun.id,
                stepName: 'callFlow',
                type: PauseType.WEBHOOK,
                version: 'V1',
            })

            // `LOCKED_FALL_BACK_TO_LATEST` (what `callWebhookSync` always uses) maps to
            // `RunEnvironment.PRODUCTION` in `webhookService.handleWebhook` — this is the
            // production entry point's PRODUCTION branch, not a TESTING shortcut.
            const createdRun = await callWebhookSync({
                flowId: flow.id,
                parentRunId: parentRun.id,
                failParentOnFailure: true,
                parentWaitpointId: waitpoint.id,
            })
            expect(createdRun).toBeDefined()
            expect(createdRun?.environment).toBe(RunEnvironment.PRODUCTION)

            // The row does not exist until the drain writes it — waiting for it to appear is
            // waiting for exactly the `add()` -> `stripToRunsMetadataUpsertData` -> `save()` path
            // this bug lived in.
            await waitForCondition({
                fn: async () => {
                    const persisted = await db.findOneBy('flow_run', { id: createdRun!.id })
                    return persisted !== null
                },
            })
            const persistedChild = await db.findOneByOrFail<{ parentWaitpointId: string | null }>('flow_run', { id: createdRun!.id })
            expect(persistedChild.parentWaitpointId).toBe(waitpoint.id)

            await createHandlers(app!.log).uploadRunLog({
                runId: createdRun!.id,
                projectId: mockProject.id,
                status: FlowRunStatus.FAILED,
                finishTime: new Date().toISOString(),
            })

            // resumeFromWaitpoint's PAUSED branch deletes the waitpoint row once the resume is
            // enqueued (see resume-flow-run.test.ts) — "gone" is the signal the parent's own
            // waitpoint was actually completed and resumed, not left untouched.
            await waitForCondition({
                fn: async () => {
                    const w = await db.findOneBy('waitpoint', { id: waitpoint.id })
                    return w === null
                },
            })

            const resumeJobData = await getResumeJobData(parentRun.id)
            const rawPayload = await resolveResumePayload({ jobPayload: resumeJobData.payload, projectId: mockProject.id })
            const payload = ResumeErrorPayload.parse(rawPayload)
            expect(payload.body.status).toBe('error')
            expect(payload.body.data.message).toBe('Subflow execution failed')
        })
    })
})

type ResolveResumePayloadParams = {
    jobPayload: JobPayload
    projectId: string
}

type WaitForConditionParams = {
    fn: () => Promise<boolean>
    timeoutMs?: number
}
