import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { frameworkCensusController } from './framework-census-controller'

export const frameworkCensusModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(frameworkCensusController, { prefix: '/v1/framework-census' })
}
