import {
    DefaultProjectRole,
    InvitationType,
    PlatformRole,
    PrincipalType,
    ProjectMemberRoleResponse,
    ProjectMemberWithUser,
    ProjectType,
    ProjectWithLimits,
    User,
    UserInvitationWithLink,
} from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockProject, createMockUserIdentity, mockBasicUser } from '../../../helpers/mocks'
import { createMemberContext, createTestContext } from '../../../helpers/test-context'
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

// This is the endpoint `useAuthorization` (packages/web/src/hooks/authorization-hooks.ts) reads to
// decide what to render — see #93. It has to answer correctly for every bypass path
// `authorize.ts:assertAccessToProject` recognizes, not just plain TEAM membership, or the web
// client would hide controls for an owner/admin who actually has them.
describe('GET /v1/project-members/role', () => {
    it('reports the caller\'s own role in a TEAM project', async () => {
        const ctx = await createTestContext(app!)
        const viewerCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.VIEWER })
        const adminCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

        const viewerRes = await viewerCtx.get('/v1/project-members/role', { projectId: ctx.project.id })
        expect(viewerRes.statusCode).toBe(StatusCodes.OK)
        expect(viewerRes.json<ProjectMemberRoleResponse>().role).toBe(DefaultProjectRole.VIEWER)

        const adminRes = await adminCtx.get('/v1/project-members/role', { projectId: ctx.project.id })
        expect(adminRes.statusCode).toBe(StatusCodes.OK)
        expect(adminRes.json<ProjectMemberRoleResponse>().role).toBe(DefaultProjectRole.ADMIN)
    })

    it('reports Admin for the owner of a PERSONAL project even without a project_member row', async () => {
        const ctx = await createTestContext(app!)
        const { mockUser: owner } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const personalProject = createMockProject({
            ownerId: owner.id,
            platformId: ctx.platform.id,
            type: ProjectType.PERSONAL,
        })
        await db.save('project', personalProject)

        const ownerToken = await generateMockToken({
            id: owner.id,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })
        const roleRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/project-members/role?projectId=${personalProject.id}`,
            headers: { authorization: `Bearer ${ownerToken}` },
        })
        expect(roleRes.statusCode).toBe(StatusCodes.OK)
        expect(roleRes.json<ProjectMemberRoleResponse>().role).toBe(DefaultProjectRole.ADMIN)

        // The Admin verdict above must come from the owner-bypass, not from a membership row —
        // otherwise this test would pass for the wrong reason.
        const membership = await db.findOneBy('project_member', {
            userId: owner.id,
            projectId: personalProject.id,
        })
        expect(membership).toBeNull()
    })

    it('reports Admin for a platform admin who has no membership row in the project', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = (await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        // ctx.user is the platform ADMIN from mockAndSaveBasicSetup and never gets a project_member
        // row of their own — the privileged bypass in authorize.ts is what grants access instead.
        const roleRes = await ctx.get('/v1/project-members/role', { projectId: teamProject.id })
        expect(roleRes.statusCode).toBe(StatusCodes.OK)
        expect(roleRes.json<ProjectMemberRoleResponse>().role).toBe(DefaultProjectRole.ADMIN)
    })

    it('rejects a non-member on the same platform (AUTHORIZATION)', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = (await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        const { mockUser: bystander } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const bystanderToken = await generateMockToken({
            id: bystander.id,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })

        const roleRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/project-members/role?projectId=${teamProject.id}`,
            headers: { authorization: `Bearer ${bystanderToken}` },
        })
        expect(roleRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(roleRes.json<{ code: string }>().code).toBe('AUTHORIZATION')
    })
})
