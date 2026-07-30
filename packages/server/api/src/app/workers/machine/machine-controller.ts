import { createRpcServer, PrincipalType, WebsocketServerEvent, WorkerMachineHealthcheckRequest, WorkerToApiContract } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { Socket } from 'socket.io'
import { z } from 'zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { websocketService } from '../../core/websockets.service'
import { jobQueue } from '../job-queue/job-queue'
import { createHandlers } from '../rpc/worker-rpc-service'
import { machineService } from './machine-service'

export const workerMachineController: FastifyPluginAsyncZod = async (app) => {

    websocketService.addListener(PrincipalType.WORKER, WebsocketServerEvent.FETCH_WORKER_SETTINGS, (socket) => {
        return async (request: WorkerMachineHealthcheckRequest, _principal, _projectId, callback?: (data: unknown) => void) => {
            const workerGroupId = readWorkerGroupId(socket)
            const response = await machineService(app.log).onConnection(request, workerGroupId)
            callback?.(response)
            createRpcServer<WorkerToApiContract>(socket, createHandlers(app.log, workerGroupId))
        }
    })

    // A worker whose version does not match the app never completes a `poll`, and `poll` is the
    // call that would otherwise keep its registry entry alive — so it sends this instead, and
    // stays reported (with its version) for as long as it is actually connected (#222). It
    // deliberately does not re-run `createRpcServer`: that would add a second `rpc` listener to
    // the same socket on every heartbeat, and both copies would answer each request.
    websocketService.addListener(PrincipalType.WORKER, WebsocketServerEvent.WORKER_HEALTHCHECK, (socket) => {
        return async (request: WorkerMachineHealthcheckRequest) => {
            await machineService(app.log).onConnection(request, readWorkerGroupId(socket))
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


function readWorkerGroupId(socket: Socket): string | undefined {
    const rawWorkerGroupId = socket.handshake.auth?.workerGroupId
    return typeof rawWorkerGroupId === 'string' ? rawWorkerGroupId : undefined
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
