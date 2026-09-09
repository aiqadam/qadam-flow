import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { inlineSubflowController } from './inline-subflow.controller'

export const inlineSubflowModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(inlineSubflowController, { prefix: '/v1/worker/flow-runs' })
}
