import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { entitiesMustBeOwnedByCurrentProject } from '../authentication/authorization'
import { projectHooks } from '../project/project-hooks'
import { alertsController } from './alerts-controller'
import { alertsService } from './alerts-service'

export const alertsModule: FastifyPluginAsyncZod = async (app) => {
    app.addHook('preSerialization', entitiesMustBeOwnedByCurrentProject)
    // project-service can't import alertsService directly (project -> alerts -> project cycle,
    // since alertsService itself depends on projectService). Registering the sweep here keeps
    // the pairing enforced by project-service#softDelete instead of by controller convention.
    projectHooks.set(log => ({
        postCreate: async () => {
            return
        },
        postSoftDelete: async (entityManager, { projectId }) => {
            await alertsService(log).deleteAllForProject({ projectId, entityManager })
        },
    }))
    await app.register(alertsController, { prefix: '/v1/alerts' })
}
