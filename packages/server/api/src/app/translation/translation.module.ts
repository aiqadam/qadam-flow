import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { entitiesMustBeOwnedByCurrentProject } from '../authentication/authorization'
import { translationWorkerController } from './translation-worker.controller'
import { translationController } from './translation.controller'

export const translationModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)
    await app.register(translationController, {
        prefix: '/v1/translations',
    })
    await app.register(translationWorkerController, {
        prefix: '/v1/worker/translations',
    })
}
