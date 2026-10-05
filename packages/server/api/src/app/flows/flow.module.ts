import { Permission, PrincipalType, TestFlowRunRequestBody, WebsocketClientEvent, WebsocketServerEvent } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { websocketService } from '../core/websockets.service'
import { flowVersionController } from './flow/flow-version.controller'
import { flowController } from './flow/flow.controller'
import { flowRunService } from './flow-run/flow-run-service'
import { sampleDataController } from './step-run/sample-data.controller'

export const flowModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(flowVersionController, { prefix: '/v1/flows' })
    await app.register(flowController, { prefix: '/v1/flows' })
    await app.register(sampleDataController, { prefix: '/v1/sample-data' })
    // Membership-only by design: a test run mirrors the membership-only
    // `/v1/sample-data/test-step` route (no `permission`). A production manual run, however,
    // is a write and requires WRITE_RUN, the same permission the HTTP run-mutation routes use.
    websocketService.addListener({
        principalType: PrincipalType.USER,
        event: WebsocketServerEvent.TEST_FLOW_RUN,
        handler: (socket) => {
            return async (data: TestFlowRunRequestBody, principal, projectId) => {
                const flowRun = await flowRunService(app.log).test({
                    projectId,
                    flowVersionId: data.flowVersionId,
                    triggeredBy: principal.id,
                })
                socket.emit(WebsocketClientEvent.TEST_FLOW_RUN_STARTED, flowRun)
            }
        },
    })
    websocketService.addListener({
        principalType: PrincipalType.USER,
        event: WebsocketServerEvent.MANUAL_TRIGGER_RUN_STARTED,
        handler: (socket) => {
            return async (data: TestFlowRunRequestBody, principal, projectId) => {
                const flowRun = await flowRunService(app.log).startManualTrigger({
                    projectId,
                    flowVersionId: data.flowVersionId,
                    triggeredBy: principal.id,
                })
                socket.emit(WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED, flowRun)
            }
        },
        permission: Permission.WRITE_RUN,
    })
}
