import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { mfaController } from './mfa.controller'

export const mfaModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(mfaController, {
        prefix: '/v1/mfa',
    })
}
