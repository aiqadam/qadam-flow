import { Project, ProjectId } from '@aiqadam/shared'
import { EntityManager } from 'typeorm'
import { hooksFactory } from '../helper/hooks-factory'

export const projectHooks = hooksFactory.create<ProjectHooks>(_log => ({
    postCreate: async (_project: Project, _context?: ProjectPostCreateContext) => {
        return
    },
    // Runs inside the same transaction as the soft-delete (see project-service#softDelete),
    // so a caller-registered implementation must only touch the DB via the given entityManager
    // — no queue enqueues, outbound calls, or cache invalidations here.
    postSoftDelete: async (_params: ProjectPostSoftDeleteParams) => {
        return
    },
}))

export type ProjectPostCreateContext = {
    alertReceiverEmail?: string | null
}

export type ProjectPostSoftDeleteParams = {
    entityManager: EntityManager
    projectId: ProjectId
}

export type ProjectHooks = {
    postCreate(project: Project, context?: ProjectPostCreateContext): Promise<void>
    postSoftDelete(params: ProjectPostSoftDeleteParams): Promise<void>
}
