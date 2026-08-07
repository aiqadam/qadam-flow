import { DefaultProjectRole, ErrorCode, isNil, ProjectMemberWithUser, ProjectType, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { userService } from '../../user/user-service'
import { ProjectMemberEntity } from '../project-member.entity'
import { projectService } from '../project-service'

const repo = repoFactory(ProjectMemberEntity)

export const projectMemberService = (log: FastifyBaseLogger) => ({
    async list({ projectId }: ListParams): Promise<ProjectMemberWithUser[]> {
        return repo().createQueryBuilder('pm')
            .innerJoin('user', 'usr', 'usr.id = pm."userId"')
            .innerJoin('user_identity', 'ui', 'ui.id = usr."identityId"')
            .innerJoin('project_role', 'pr', 'pr.id = pm."projectRoleId"')
            .where('pm."projectId" = :projectId', { projectId })
            .select([
                'pm.id AS id',
                'pm."userId" AS "userId"',
                'pm."projectId" AS "projectId"',
                'ui.email AS email',
                'ui."firstName" AS "firstName"',
                'ui."lastName" AS "lastName"',
                'pr.name AS "projectRole"',
            ])
            .getRawMany<ProjectMemberWithUser>()
    },

    // Mirrors the bypass order in `authorize.ts:assertAccessToProject` (privileged principal, then
    // personal-project owner, then TEAM membership) so the role reported here matches what the
    // server would actually enforce on a mutation — a stale answer here would recreate the exact
    // UX gap this endpoint exists to close.
    async getMyRole({ projectId, userId }: GetMyRoleParams): Promise<{ role: DefaultProjectRole }> {
        const user = await userService(log).getOneOrFail({ id: userId })
        if (userService(log).isUserPrivileged(user)) {
            return { role: DefaultProjectRole.ADMIN }
        }

        const project = await projectService(log).getOneOrThrow(projectId)
        if (project.type === ProjectType.PERSONAL && project.ownerId === userId) {
            return { role: DefaultProjectRole.ADMIN }
        }

        const role = await projectService(log).getProjectRoleForUser({
            userId,
            projectId,
            platformId: project.platformId,
        })
        if (isNil(role) || !isDefaultProjectRole(role.name)) {
            // `securityAccess.project` already asserted the caller has access to this project, so
            // reaching here means the membership row disappeared (or names a non-default role,
            // which CE never creates) between that check and this query — not a normal 403.
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'Unable to resolve a default project role for this member.',
                },
            })
        }
        return { role: role.name }
    },
})

function isDefaultProjectRole(name: string): name is DefaultProjectRole {
    const roles: string[] = Object.values(DefaultProjectRole)
    return roles.includes(name)
}

type ListParams = {
    projectId: string
}

type GetMyRoleParams = {
    projectId: string
    userId: string
}
