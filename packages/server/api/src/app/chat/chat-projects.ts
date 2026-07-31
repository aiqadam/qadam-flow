import { isNil, Project } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { projectService } from '../project/project-service'
import { userService } from '../user/user-service'

export const chatProjects = {
    // Deliberately the same list the projects page shows the user (project-controller.ts:43): the
    // chat must never reach a project the user could not open themselves, and must not refuse one
    // they can.
    async accessible({ platformId, userId, log }: AccessibleParams): Promise<Project[]> {
        const user = await userService(log).getOneOrFail({ id: userId })
        return projectService(log).getAllForUser({
            platformId,
            userId,
            isPrivileged: userService(log).isUserPrivileged(user),
        })
    },

    // One definition of "may this conversation still reach this project", used by both the run
    // loop and the connection picker. They had separate answers once: the loop re-checked
    // membership on every turn while the picker only proved conversation ownership, so a member
    // removed from a project could still enumerate its connections through a conversation they
    // owned. Keeping the check in one place is what stops that reappearing.
    async findAccessible({ projectId, platformId, userId, log }: FindAccessibleParams): Promise<Project | null> {
        if (isNil(projectId)) {
            return null
        }
        const projects = await this.accessible({ platformId, userId, log })
        return projects.find((project) => project.id === projectId) ?? null
    },
}

type AccessibleParams = {
    platformId: string
    userId: string
    log: FastifyBaseLogger
}

type FindAccessibleParams = AccessibleParams & {
    projectId: string | null
}
