import { DefaultProjectRole, ErrorCode, ProjectMemberWithUser, QadamFlowError } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
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

    // Uses the same shared resolver as `authorize.ts:assertAccessToProject` and the websocket
    // join, so the role reported here matches what the server would actually enforce on a
    // mutation — a stale answer here would recreate the exact UX gap this endpoint exists to close.
    async getMyRole({ projectId, userId }: GetMyRoleParams): Promise<{ role: DefaultProjectRole }> {
        const access = await projectService(log).resolveUserProjectAccessOrThrow({ userId, projectId })
        // A `bypass` is the privileged-user / PERSONAL-owner case; both act as project ADMIN.
        if (access.kind === 'bypass') {
            return { role: DefaultProjectRole.ADMIN }
        }
        if (!isDefaultProjectRole(access.role.name)) {
            // `securityAccess.project` already asserted the caller has access to this project, so
            // reaching here means the membership row names a non-default role (which CE never
            // creates) — not a normal 403.
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'Unable to resolve a default project role for this member.',
                },
            })
        }
        return { role: access.role.name }
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
