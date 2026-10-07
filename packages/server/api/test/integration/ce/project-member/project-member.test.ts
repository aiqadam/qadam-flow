import {
    apId,
    DefaultProjectRole,
    InvitationStatus,
    InvitationType,
    PlatformRole,
    PrincipalType,
    ProjectMember,
    ProjectMemberCandidate,
    ProjectMemberManagedBy,
    ProjectMemberRoleResponse,
    ProjectMemberWithUser,
    ProjectRole,
    ProjectType,
    ProjectWithLimits,
    User,
    UserInvitationWithLink,
    UserStatus,
} from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { websocketService } from '../../../../src/app/core/websockets.service'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockProject, createMockProjectMember, createMockUserIdentity, mockBasicUser } from '../../../helpers/mocks'
import { createMemberContext, createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

// `fresh: true` because the eviction test spies on `websocketService` — the shared server captures
// its module references from the first evaluation, so a reused server would patch the wrong instance.
beforeAll(async () => {
    app = await setupTestEnvironment({ fresh: true })
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

    it('hides a member whose user is detached or inactive', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const detached = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        const inactive = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        await db.save('user', { ...(await db.findOneByOrFail<User>('user', { id: detached.userId })), platformId: null })
        await db.save('user', { ...(await db.findOneByOrFail<User>('user', { id: inactive.userId })), status: UserStatus.INACTIVE })

        const listRes = await ctx.get(`/v1/project-members?projectId=${teamProject.id}`)
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const listed = listRes.json<ProjectMemberWithUser[]>()
        expect(listed.some((m) => m.userId === detached.userId)).toBe(false)
        expect(listed.some((m) => m.userId === inactive.userId)).toBe(false)
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

async function createTeamProject(ctx: Awaited<ReturnType<typeof createTestContext>>): Promise<ProjectWithLimits> {
    const res = await ctx.post('/v1/projects', {
        displayName: faker.animal.bird(),
        externalId: null,
        metadata: null,
        maxConcurrentJobs: null,
    })
    expect(res.statusCode).toBe(StatusCodes.CREATED)
    return res.json<ProjectWithLimits>()
}

async function createPendingProjectInvitation({
    platformId,
    projectId,
    email,
    projectRoleId,
}: CreatePendingProjectInvitationParams): Promise<void> {
    await db.save('user_invitation', {
        id: apId(),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        platformId,
        type: InvitationType.PROJECT,
        platformRole: null,
        email,
        projectId,
        status: InvitationStatus.PENDING,
        projectRoleId,
    })
}

async function findDefaultProjectRole({ ctx, name }: FindDefaultProjectRoleParams): Promise<ProjectRole> {
    return db.findOneByOrFail<ProjectRole>('project_role', {
        name,
        platformId: ctx.platform.id,
    })
}

async function findMemberId({ ctx, projectId, userId }: FindMemberIdParams): Promise<string> {
    const listRes = await ctx.get(`/v1/project-members?projectId=${projectId}`)
    expect(listRes.statusCode).toBe(StatusCodes.OK)
    const member = listRes.json<ProjectMemberWithUser[]>().find((m) => m.userId === userId)
    expect(member).toBeDefined()
    return member!.id
}

describe('POST /v1/project-members/:id', () => {
    it('changes the role of a member', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.VIEWER,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const res = await ctx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(res.statusCode).toBe(StatusCodes.OK)
        expect(res.json<ProjectMemberWithUser>().projectRole).toBe(DefaultProjectRole.EDITOR)

        const listRes = await ctx.get(`/v1/project-members?projectId=${teamProject.id}`)
        const updated = listRes.json<ProjectMemberWithUser[]>().find((m) => m.userId === member.userId)
        expect(updated?.projectRole).toBe(DefaultProjectRole.EDITOR)
    })

    it('rejects changing an LDAP-managed membership', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.VIEWER,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })
        const row = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        await db.save('project_member', { ...row, managedBy: ProjectMemberManagedBy.LDAP })

        const res = await ctx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const unchanged = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        expect(unchanged.projectRoleId).toBe(row.projectRoleId)
    })

    it('rejects changing your own membership', async () => {
        const ctx = await createTestContext(app!)
        const memberCtx = await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })
        // A second admin, so the self guard is the only possible reason for the rejection below.
        await createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })
        const memberId = await findMemberId({ ctx, projectId: ctx.project.id, userId: memberCtx.user.id })

        const res = await memberCtx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.VIEWER,
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const adminRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.ADMIN })
        const unchanged = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        expect(unchanged.projectRoleId).toBe(adminRole.id)
    })

    it('rejects demoting the last admin', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        // Drop the owner's own membership row so the invited admin is the project's only admin.
        await db.delete('project_member', { userId: ctx.user.id, projectId: teamProject.id })
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.ADMIN,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const res = await ctx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.VIEWER,
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const adminRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.ADMIN })
        const unchanged = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        expect(unchanged.projectRoleId).toBe(adminRole.id)
    })

    it('does not count a detached admin row as protection for the last active admin', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        // The invited admin is the project's only *active* admin.
        await db.delete('project_member', { userId: ctx.user.id, projectId: teamProject.id })
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.ADMIN,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        // An off-boarded admin: the user row is detached from the platform, but its membership row
        // lingers (`removeFromPlatform` only nulls `user.platformId`).
        const { mockUser: detachedAdmin } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        await db.save('user', { ...detachedAdmin, platformId: null })
        const adminRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.ADMIN })
        await db.save('project_member', createMockProjectMember({
            userId: detachedAdmin.id,
            platformId: ctx.platform.id,
            projectId: teamProject.id,
            projectRoleId: adminRole.id,
        }))

        const res = await ctx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.VIEWER,
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const unchanged = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        expect(unchanged.projectRoleId).toBe(adminRole.id)
    })

    it('does not count an inactive admin row as protection for the last active admin', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        await db.delete('project_member', { userId: ctx.user.id, projectId: teamProject.id })
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.ADMIN,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        // A deactivated admin: `user.status` is INACTIVE (which denies project access) but the
        // membership row remains.
        const { mockUser: inactiveAdmin } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        await db.save('user', { ...inactiveAdmin, status: UserStatus.INACTIVE })
        const adminRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.ADMIN })
        await db.save('project_member', createMockProjectMember({
            userId: inactiveAdmin.id,
            platformId: ctx.platform.id,
            projectId: teamProject.id,
            projectRoleId: adminRole.id,
        }))

        const res = await ctx.post(`/v1/project-members/${memberId}`, {
            projectRole: DefaultProjectRole.VIEWER,
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const unchanged = await db.findOneByOrFail<ProjectMember>('project_member', { id: memberId })
        expect(unchanged.projectRoleId).toBe(adminRole.id)
    })

    it('rejects a non-member of the project (AUTHORIZATION)', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.VIEWER,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const { mockUser: bystander } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const bystanderToken = await generateMockToken({
            id: bystander.id,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })
        const res = await app!.inject({
            method: 'POST',
            url: `/api/v1/project-members/${memberId}`,
            headers: { authorization: `Bearer ${bystanderToken}` },
            payload: { projectRole: DefaultProjectRole.EDITOR },
        })
        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(res.json<{ code: string }>().code).toBe('AUTHORIZATION')
    })
})

describe('DELETE /v1/project-members/:id', () => {
    it('removes a member', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const res = await ctx.delete(`/v1/project-members/${memberId}`)
        expect(res.statusCode).toBe(StatusCodes.NO_CONTENT)

        const listRes = await ctx.get(`/v1/project-members?projectId=${teamProject.id}`)
        expect(listRes.json<ProjectMemberWithUser[]>().find((m) => m.userId === member.userId)).toBeUndefined()
    })

    it('revokes a pending invitation for the removed member\'s email', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })
        const editorRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.EDITOR })
        await createPendingProjectInvitation({
            platformId: ctx.platform.id,
            projectId: teamProject.id,
            email: member.email,
            projectRoleId: editorRole.id,
        })

        const res = await ctx.delete(`/v1/project-members/${memberId}`)
        expect(res.statusCode).toBe(StatusCodes.NO_CONTENT)

        const invitation = await db.findOneBy('user_invitation', {
            email: member.email,
            projectId: teamProject.id,
        })
        expect(invitation).toBeNull()
    })

    it('evicts the removed member from the project websocket room', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const evictSpy = vi.spyOn(websocketService, 'evictUserFromProjects').mockImplementation(() => undefined)
        try {
            const res = await ctx.delete(`/v1/project-members/${memberId}`)
            expect(res.statusCode).toBe(StatusCodes.NO_CONTENT)
            expect(evictSpy).toHaveBeenCalledWith({
                userId: member.userId,
                projectIds: [teamProject.id],
            })
        }
        finally {
            evictSpy.mockRestore()
        }
    })

    it('rejects removing the project owner', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        // Removed by a *different* admin: as the owner themselves the self guard would reject first,
        // and as the only admin the last-admin guard would too — neither would exercise the owner guard.
        const secondAdmin = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.ADMIN,
        })
        const secondAdminToken = await generateMockToken({
            id: secondAdmin.userId,
            type: PrincipalType.USER,
            platform: { id: ctx.platform.id },
        })
        const ownerMemberId = await findMemberId({ ctx, projectId: teamProject.id, userId: ctx.user.id })

        const res = await app!.inject({
            method: 'DELETE',
            url: `/api/v1/project-members/${ownerMemberId}`,
            headers: { authorization: `Bearer ${secondAdminToken}` },
        })
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const stillThere = await db.findOneBy<ProjectMember>('project_member', { id: ownerMemberId })
        expect(stillThere).not.toBeNull()
    })

    it('rejects removing the last admin', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        await db.delete('project_member', { userId: ctx.user.id, projectId: teamProject.id })
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.ADMIN,
        })
        const memberId = await findMemberId({ ctx, projectId: teamProject.id, userId: member.userId })

        const res = await ctx.delete(`/v1/project-members/${memberId}`)
        expect(res.statusCode).toBe(StatusCodes.CONFLICT)
        expect(res.json<{ code: string }>().code).toBe('VALIDATION')
        const stillThere = await db.findOneBy<ProjectMember>('project_member', { id: memberId })
        expect(stillThere).not.toBeNull()
    })
})

describe('GET /v1/project-members/candidates', () => {
    it('lists platform users not yet in the project and excludes members, admins and invited users', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const member = await inviteAndAccept({
            ctx,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.VIEWER,
        })
        const { mockUser: candidate, mockUserIdentity: candidateIdentity } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        // A platform ADMIN who is not a project member — `ctx.user` cannot prove the exclusion
        // because it is also the project's creator and so already filtered out as a member.
        const { mockUser: platformAdmin } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.ADMIN },
        })

        const res = await ctx.get(`/v1/project-members/candidates?projectId=${teamProject.id}`)
        expect(res.statusCode).toBe(StatusCodes.OK)
        const candidates = res.json<ProjectMemberCandidate[]>()
        expect(candidates.some((c) => c.userId === candidate.id)).toBe(true)
        // Already a member.
        expect(candidates.some((c) => c.userId === member.userId)).toBe(false)
        // Platform ADMIN/OPERATOR have platform-level access and are not offered.
        expect(candidates.some((c) => c.userId === platformAdmin.id)).toBe(false)

        // A pending invitation for an otherwise eligible user hides them until it is revoked.
        const editorRole = await findDefaultProjectRole({ ctx, name: DefaultProjectRole.EDITOR })
        await createPendingProjectInvitation({
            platformId: ctx.platform.id,
            projectId: teamProject.id,
            email: candidateIdentity.email,
            projectRoleId: editorRole.id,
        })
        const invitedRes = await ctx.get(`/v1/project-members/candidates?projectId=${teamProject.id}`)
        const invitedCandidates = invitedRes.json<ProjectMemberCandidate[]>()
        expect(invitedCandidates.some((c) => c.userId === candidate.id)).toBe(false)
    })

    // A PERSONAL-project owner resolves to the permission `bypass`, which satisfies WRITE_INVITATION
    // like any other permission — without the project-type guard this would hand a plain platform
    // MEMBER the whole platform directory that `GET /v1/users` keeps admin-only.
    it('rejects a personal project even for its own owner', async () => {
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

        const res = await app!.inject({
            method: 'GET',
            url: `/api/v1/project-members/candidates?projectId=${personalProject.id}`,
            headers: { authorization: `Bearer ${ownerToken}` },
        })
        expect(res.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(res.json<{ code: string }>().code).toBe('AUTHORIZATION')
    })

    it('filters candidates server-side by the search term', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const { mockUser: alice, mockUserIdentity: aliceIdentity } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
            userIdentity: { firstName: 'Alice', lastName: 'Anderson' },
        })
        const { mockUser: bob } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
            userIdentity: { firstName: 'Bob', lastName: 'Brown' },
        })

        const byName = await ctx.get(`/v1/project-members/candidates?projectId=${teamProject.id}&search=alice`)
        expect(byName.statusCode).toBe(StatusCodes.OK)
        const namedCandidates = byName.json<ProjectMemberCandidate[]>()
        expect(namedCandidates.some((c) => c.userId === alice.id)).toBe(true)
        expect(namedCandidates.some((c) => c.userId === bob.id)).toBe(false)

        const byEmail = await ctx.get(`/v1/project-members/candidates?projectId=${teamProject.id}&search=${encodeURIComponent(aliceIdentity.email)}`)
        expect(byEmail.json<ProjectMemberCandidate[]>().some((c) => c.userId === alice.id)).toBe(true)

        const noMatch = await ctx.get(`/v1/project-members/candidates?projectId=${teamProject.id}&search=no-such-user`)
        expect(noMatch.json<ProjectMemberCandidate[]>().some((c) => c.userId === alice.id || c.userId === bob.id)).toBe(false)
    })
})

type FindMemberIdParams = {
    ctx: Awaited<ReturnType<typeof createTestContext>>
    projectId: string
    userId: string
}

type FindDefaultProjectRoleParams = {
    ctx: Awaited<ReturnType<typeof createTestContext>>
    name: DefaultProjectRole
}

type CreatePendingProjectInvitationParams = {
    platformId: string
    projectId: string
    email: string
    projectRoleId: string
}
