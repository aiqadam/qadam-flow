import { ProjectId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { alertsService } from '../alerts/alerts-service'

export const projectSideEffects = (log: FastifyBaseLogger) => ({
    // Projects are soft-deleted, so no FK cascade fires — alert rows would otherwise
    // accumulate forever against a project that can no longer be listed.
    async postSoftDelete({ projectId }: PostSoftDeleteParams): Promise<void> {
        await alertsService(log).deleteAllForProject({ projectId })
    },
})

type PostSoftDeleteParams = {
    projectId: ProjectId
}
