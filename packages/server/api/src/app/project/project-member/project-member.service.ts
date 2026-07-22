import { ProjectMemberWithUser } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { ProjectMemberEntity } from '../project-member.entity'

const repo = repoFactory(ProjectMemberEntity)

export const projectMemberService = (_log: FastifyBaseLogger) => ({
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
})

type ListParams = {
    projectId: string
}
