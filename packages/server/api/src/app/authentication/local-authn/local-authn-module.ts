import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { localAuthnController } from './local-authn-controller'

export const localAuthnModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(localAuthnController, {
        prefix: '/v1/authn/local',
    })
}
