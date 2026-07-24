import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { apiKeyController } from './api-key.controller'

export const apiKeyModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(apiKeyController, { prefix: '/v1/api-keys' })
}
