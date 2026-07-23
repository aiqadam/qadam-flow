import {
    DefaultProjectRole,
    InvitationType,
    PlatformRole,
    PrincipalType,
    ProjectMemberWithUser,
    ProjectWithLimits,
    User,
    UserInvitationWithLink,
} from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockUserIdentity, mockBasicUser } from '../../../helpers/mocks'
import { createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

async function inviteAndAccept({ ctx, projectId, projectRole }: {
    ctx: Awaited<ReturnType<typeof createTestContext>>
    projectId: string
    projectRole: DefaultProjectRole
}): Promise<{ identityId: string, email: string, userId: string }> {
    const identity = createMockUserIdentity({ verified: true })
    await db.save('user_identity', identity)

    const inviteRes = await ctx.post('/v1/user-invitations', {
        email: identity.email,
        type: InvitationType.PROJECT,
        projectId,
        projectRole,
    })
    expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
    const invitation = inviteRes.json<UserInvitationWithLink>()
    const invitationToken = new URL(invitation.link!).searchParams.get('token')!

    const acceptRes = await app!.inject({
        method: 'POST',
        url: '/api/v1/user-invitations/accept',
        payload: { invitationToken },
    })
    expect(acceptRes.statusCode).toBe(StatusCodes.OK)

    const user = await db.findOneByOrFail<User>('user', {
        identityId: identity.id,
        platformId: ctx.platform.id,
    })
    return { identityId: identity.id, email: identity.email, userId: user.id }
}

describe('GET /v1/project-members', () => {
    it('lists accepted members with email, name and project role', async () => {
        const ctx = await createTestContext(app!)

        const teamProject = (await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })

        const listRes = await ctx.get(`/v1/project-members?projectId=${teamProject.id}`)
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const members = listRes.json<ProjectMemberWithUser[]>()

        const found = members.find((m) => m.userId === member.userId)
        expect(found).toBeDefined()
        expect(found?.email).toBe(member.email)
        expect(found?.projectId).toBe(teamProject.id)
        expect(found?.projectRole).toBe(DefaultProjectRole.EDITOR)
    })

    it('does not leak members of another project', async () => {
        const ctx = await createTestContext(app!)

        const projectA = (await ctx.post('/v1/projects', {
            displayName: `A ${faker.animal.bird()}`,
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()
        const projectB = (await ctx.post('/v1/projects', {
            displayName: `B ${faker.animal.fish()}`,
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        const memberA = await inviteAndAccept({
            ctx,
            projectId: projectA.id,
            projectRole: DefaultProjectRole.EDITOR,
        })

        const listB = await ctx.get(`/v1/project-members?projectId=${projectB.id}`)
        expect(listB.statusCode).toBe(StatusCodes.OK)
        const membersB = listB.json<ProjectMemberWithUser[]>()
        expect(membersB.find((m) => m.userId === memberA.userId)).toBeUndefined()
    })

    it('rejects a non-member on the same platform (AUTHORIZATION)', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = (await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        const { mockUser: bystander } = await mockBasicUser({
            user: {
                platformId: ctx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const bystanderToken = await generateMockToken({
            id: bystander.id,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })

        const listRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/project-members?projectId=${teamProject.id}`,
            headers: { authorization: `Bearer ${bystanderToken}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(listRes.json<{ code: string }>().code).toBe('AUTHORIZATION')
    })
})
