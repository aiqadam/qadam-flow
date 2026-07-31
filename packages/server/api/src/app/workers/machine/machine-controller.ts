import { createRpcServer, isNil, PrincipalType, WebsocketServerEvent, WorkerMachineHealthcheckRequest, WorkerToApiContract } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { websocketService } from '../../core/websockets.service'
import { jobQueue } from '../job-queue/job-queue'
import { createHandlers } from '../rpc/worker-rpc-service'
import { machineService } from './machine-service'

export const workerMachineController: FastifyPluginAsyncZod = async (app) => {

    websocketService.addListener(PrincipalType.WORKER, WebsocketServerEvent.FETCH_WORKER_SETTINGS, (socket) => {
        return async (request: unknown, principal, _projectId, callback?: (data: unknown) => void) => {
            const workerGroupId = readWorkerGroupId(principal)
            const information = parseHealthcheck(request, app.log)
            // Fail closed on STORAGE, open on LIVENESS. A payload that does not parse never
            // reaches the registry or the admin table — but it must not stop the worker booting:
            // the ack below is awaited by `fetchAndStoreSettings` with no timeout, on a socket
            // that stays connected, so withholding it wedges the worker permanently with nothing
            // to reconnect and no log of its own. The fields are machine telemetry the worker
            // does not choose (a `si.mem()` fallback yielding NaN is enough), so gating job
            // execution on them would trade a monitoring gap for an outage.
            const response = isNil(information)
                ? await machineService(app.log).settingsOnly()
                : await machineService(app.log).onConnection(information, workerGroupId)
            callback?.(response)
            createRpcServer<WorkerToApiContract>(socket, createHandlers(app.log, workerGroupId))
        }
    })

    // A worker whose version does not match the app never completes a `poll`, and `poll` is the
    // call that would otherwise keep its registry entry alive — so it sends this instead, and
    // stays reported (with its version) for as long as it is actually connected (#222). It
    // deliberately does not re-run `createRpcServer`: that would add a second `rpc` listener to
    // the same socket on every heartbeat, and both copies would answer each request.
    websocketService.addListener(PrincipalType.WORKER, WebsocketServerEvent.WORKER_HEALTHCHECK, () => {
        return async (request: unknown, principal) => {
            const information = parseHealthcheck(request, app.log)
            if (isNil(information)) {
                return
            }
            await machineService(app.log).onConnection(information, readWorkerGroupId(principal))
        }
    })

    websocketService.addListener(PrincipalType.WORKER, WebsocketServerEvent.DISCONNECT, (socket) => {
        return async (_request: unknown, _principal) => {
            await machineService(app.log).onDisconnect({
                workerId: socket.handshake.auth.workerId,
            })
        }
    })

    app.get('/', ListWorkersParams, async (request) => {
        return machineService(app.log).list(request.principal.platform.id)
    })

    app.get('/queue-metrics', QueueMetricsParams, async () => {
        const allQueues = jobQueue(app.log).getAllQueues()
        const counts = await Promise.all(
            allQueues.map(async (queue) => {
                const jobCounts = await queue.getJobCounts('waiting', 'active', 'prioritized')
                return { name: queue.name, waiting: jobCounts.waiting + jobCounts.prioritized, active: jobCounts.active }
            }),
        )
        return { queues: counts }
    })
}


// The payload is stored in the worker registry and rendered verbatim in the platform admin
// workers table (`information.ip` and friends), so it is parsed before it is stored rather
// than trusted for being well-formed on the wire. A worker that sends something else is
// dropped, not persisted: no settings are returned and no RPC server is attached, so it
// cannot poll either.
// `verifyPrincipal` returns the JWT payload verbatim and validates nothing but `type`, so a
// token minted with a non-string claim would otherwise flow into a BullMQ queue name and a Redis
// key via template literal. Only a JWT-secret holder can mint one, so this is hardening rather
// than a live hole — but the check it replaces (in the deleted readWorkerGroupId) did exactly
// this, and dropping it silently would be a regression in the diff that exists to tighten this.
function readWorkerGroupId(principal: { workerGroupId?: unknown }): string | undefined {
    return typeof principal.workerGroupId === 'string' ? principal.workerGroupId : undefined
}

function parseHealthcheck(request: unknown, log: FastifyBaseLogger): WorkerMachineHealthcheckRequest | null {
    const parsed = WorkerMachineHealthcheckRequest.safeParse(request)
    if (!parsed.success) {
        log.warn({ issues: parsed.error.issues }, '[machineController] Rejecting malformed worker healthcheck payload')
        return null
    }
    return parsed.data
}

const ListWorkersParams = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
}

const QueueMetricsParams = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER, PrincipalType.SERVICE]),
    },
    schema: {
        tags: ['worker-machines'],
        response: {
            200: z.object({
                queues: z.array(z.object({
                    name: z.string(),
                    waiting: z.number(),
                    active: z.number(),
                })),
            }),
        },
    },
}
