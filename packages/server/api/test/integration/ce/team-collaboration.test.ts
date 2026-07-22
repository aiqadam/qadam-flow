import {
    apId,
    DefaultProjectRole,
    InvitationType,
    Permission,
    PlatformRole,
    PrincipalType,
    ProjectType,
    ProjectWithLimits,
    RoleType,
    SeekPage,
    User,
    UserInvitationWithLink,
} from '@aiqadam/shared'
import { faker } from '@faker-js/faker'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { generateMockToken } from '../../helpers/auth'
import { db } from '../../helpers/db'
import { createMockProjectRole, createMockUserIdentity, mockBasicUser } from '../../helpers/mocks'
import { createTestContext } from '../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Team project collaboration (CE)', () => {
    it('User1 creates a team project, invites User2, User2 accepts and sees the project', async () => {
        // User1 as platform admin
        const ctx1 = await createTestContext(app!)

        // Seed a narrow EDITOR role before create so the auto-seeder skips this name and the
        // invitation uses these exact permissions (auto-seed grants the full EDITOR permission set).
        const projectRole = createMockProjectRole({
            name: DefaultProjectRole.EDITOR,
            platformId: ctx1.platform.id,
            permissions: [Permission.READ_FLOW, Permission.WRITE_FLOW],
            type: RoleType.DEFAULT,
        })
        await db.save('project_role', projectRole)

        // Create User2's identity only — no user record yet, so the invitation won't auto-accept
        const user2Identity = createMockUserIdentity({ verified: true })
        await db.save('user_identity', user2Identity)

        // Step 1: User1 creates a team project
        const createRes = await ctx1.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()
        expect(teamProject.type).toBe(ProjectType.TEAM)

        // Step 2: User1 sends invitation to User2
        const inviteRes = await ctx1.post('/v1/user-invitations', {
            email: user2Identity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        const invitation = inviteRes.json<UserInvitationWithLink>()

        // Extract the JWT from the invitation link: /invitation?token=<jwt>&email=..
        const link = invitation.link!
        const invitationToken = new URL(link).searchParams.get('token')!
        expect(invitationToken).toBeTruthy()

        // Step 3: User2 accepts the invitation (public endpoint — no auth header needed)
        const acceptRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations/accept',
            payload: { invitationToken },
        })
        expect(acceptRes.statusCode).toBe(StatusCodes.OK)

        // Step 4: Find user2's user record created during accept, then generate a token
        const user2 = await db.findOneByOrFail<User>('user', {
            identityId: user2Identity.id,
            platformId: ctx1.platform.id,
        })
        const user2Token = await generateMockToken({
            id: user2.id,
            type: PrincipalType.USER,
            platform: { id: ctx1.platform.id },
        })

        // Step 5: User2 can now see the team project in their project list
        const listRes = await app!.inject({
            method: 'GET',
            url: '/api/v1/projects',
            headers: { authorization: `Bearer ${user2Token}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const projects = listRes.json<SeekPage<ProjectWithLimits>>()
        const found = projects.data.find((p) => p.id === teamProject.id)
        expect(found).toBeDefined()
        expect(found?.displayName).toBe(teamProject.displayName)

        // Step 6: User2 can list flows in the shared project
        const flowsRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/flows?projectId=${teamProject.id}`,
            headers: { authorization: `Bearer ${user2Token}` },
        })
        expect(flowsRes.statusCode).toBe(StatusCodes.OK)
    })

    it('User2 who was NOT invited cannot see User1 team project', async () => {
        const ctx1 = await createTestContext(app!)
        const ctx2 = await createTestContext(app!)

        // User1 creates a team project
        const createRes = await ctx1.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        // User2 from a different platform cannot see User1's team project
        const listRes = await ctx2.get('/v1/projects')
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const projects = listRes.json<SeekPage<ProjectWithLimits>>()
        const found = projects.data.find((p) => p.id === teamProject.id)
        expect(found).toBeUndefined()
    })

    it('Member of team project A cannot see team project B on the same platform', async () => {
        const ctx1 = await createTestContext(app!)

        const projectRole = createMockProjectRole({
            name: DefaultProjectRole.EDITOR,
            platformId: ctx1.platform.id,
            permissions: [Permission.READ_FLOW, Permission.WRITE_FLOW],
            type: RoleType.DEFAULT,
        })
        await db.save('project_role', projectRole)

        const user2Identity = createMockUserIdentity({ verified: true })
        await db.save('user_identity', user2Identity)

        // Owner creates two team projects
        const projectA = (await ctx1.post('/v1/projects', {
            displayName: `A ${faker.animal.bird()}`,
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()
        const projectB = (await ctx1.post('/v1/projects', {
            displayName: `B ${faker.animal.fish()}`,
            externalId: null, metadata: null, maxConcurrentJobs: null,
        })).json<ProjectWithLimits>()

        // Invite user2 to project A only
        const inviteRes = await ctx1.post('/v1/user-invitations', {
            email: user2Identity.email,
            type: InvitationType.PROJECT,
            projectId: projectA.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        const invitation = inviteRes.json<UserInvitationWithLink>()
        const invitationToken = new URL(invitation.link!).searchParams.get('token')!
        await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations/accept',
            payload: { invitationToken },
        })

        const user2 = await db.findOneByOrFail<User>('user', {
            identityId: user2Identity.id,
            platformId: ctx1.platform.id,
        })
        const user2Token = await generateMockToken({
            id: user2.id,
            type: PrincipalType.USER,
            platform: { id: ctx1.platform.id },
        })

        const listRes = await app!.inject({
            method: 'GET',
            url: '/api/v1/projects',
            headers: { authorization: `Bearer ${user2Token}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const projects = listRes.json<SeekPage<ProjectWithLimits>>()

        expect(projects.data.find((p) => p.id === projectA.id)).toBeDefined()
        expect(projects.data.find((p) => p.id === projectB.id)).toBeUndefined()
        expect(projects.data.find((p) => p.type === ProjectType.PERSONAL)).toBeDefined()
    })

    it('User1 can revoke invitation before User2 accepts', async () => {
        const ctx1 = await createTestContext(app!)

        const projectRole = createMockProjectRole({
            name: DefaultProjectRole.VIEWER,
            platformId: ctx1.platform.id,
            permissions: [Permission.READ_FLOW],
            type: RoleType.DEFAULT,
        })
        await db.save('project_role', projectRole)

        // Create User2 identity only — no user record, invitation stays PENDING
        const user2Identity = createMockUserIdentity({ verified: true })
        await db.save('user_identity', user2Identity)

        const createRes = await ctx1.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        const teamProject = createRes.json<ProjectWithLimits>()

        // Send invitation
        const inviteRes = await ctx1.post('/v1/user-invitations', {
            email: user2Identity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.VIEWER,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        const invitation = inviteRes.json<UserInvitationWithLink>()

        // User1 revokes the invitation
        const deleteRes = await ctx1.delete(`/v1/user-invitations/${invitation.id}`)
        expect(deleteRes.statusCode).toBe(StatusCodes.NO_CONTENT)

        // The revoked token is now invalid — accept should fail
        const invitationToken = new URL(invitation.link!).searchParams.get('token')!
        const acceptRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations/accept',
            payload: { invitationToken },
        })
        expect(acceptRes.statusCode).not.toBe(StatusCodes.OK)
    })

    it('Creating a TEAM project auto-seeds default roles for the platform', async () => {
        const ctx = await createTestContext(app!)

        const before = await db.find<{ name: string }>('project_role', { platformId: ctx.platform.id, type: RoleType.DEFAULT })
        const beforeNames = new Set(before.map(r => r.name))
        expect(beforeNames.has(DefaultProjectRole.ADMIN)).toBe(false)
        expect(beforeNames.has(DefaultProjectRole.EDITOR)).toBe(false)
        expect(beforeNames.has(DefaultProjectRole.VIEWER)).toBe(false)

        const createRes = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)

        const after = await db.find<{ name: string, type: string }>('project_role', { platformId: ctx.platform.id, type: RoleType.DEFAULT })
        const afterNames = new Set(after.map(r => r.name))
        expect(afterNames.has(DefaultProjectRole.ADMIN)).toBe(true)
        expect(afterNames.has(DefaultProjectRole.EDITOR)).toBe(true)
        expect(afterNames.has(DefaultProjectRole.VIEWER)).toBe(true)

        const second = await ctx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(second.statusCode).toBe(StatusCodes.CREATED)
        const afterSecond = await db.find<{ name: string }>('project_role', { platformId: ctx.platform.id, type: RoleType.DEFAULT })
        expect(afterSecond.length).toBe(after.length)
    })

    it('Non-admin creator is added as project_member with ADMIN role and sees the project in list', async () => {
        // Admin exists just so the platform+dev-roles are set up via the first create
        const adminCtx = await createTestContext(app!)
        const seedRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(seedRes.statusCode).toBe(StatusCodes.CREATED)

        // Non-admin MEMBER on the same platform creates their own team project
        const { mockUser: memberUser } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const memberToken = await generateMockToken({
            id: memberUser.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const memberProjectName = faker.animal.bird()
        const createRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/projects',
            headers: { authorization: `Bearer ${memberToken}` },
            payload: {
                displayName: memberProjectName,
                externalId: null,
                metadata: null,
                maxConcurrentJobs: null,
            },
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const memberProject = createRes.json<ProjectWithLimits>()

        // project_member row exists for the creator with ADMIN role
        const membership = await db.findOneByOrFail<{ userId: string, projectId: string, projectRoleId: string }>('project_member', {
            userId: memberUser.id,
            projectId: memberProject.id,
        })
        const adminRole = await db.findOneByOrFail<{ id: string, name: string }>('project_role', {
            platformId: adminCtx.platform.id,
            name: DefaultProjectRole.ADMIN,
            type: RoleType.DEFAULT,
        })
        expect(membership.projectRoleId).toBe(adminRole.id)

        // Creator (non-admin) sees the project in their filtered list — the actual bug this covers
        const listRes = await app!.inject({
            method: 'GET',
            url: '/api/v1/projects',
            headers: { authorization: `Bearer ${memberToken}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.OK)
        const listed = listRes.json<SeekPage<ProjectWithLimits>>()
        expect(listed.data.some(p => p.id === memberProject.id)).toBe(true)
    })

    it('Non-member on the same platform cannot access a team project directly (POST /v1/folders → 403)', async () => {
        const adminCtx = await createTestContext(app!)
        const createRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        const { mockUser: bystander } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const bystanderToken = await generateMockToken({
            id: bystander.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const folderRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/folders',
            headers: { authorization: `Bearer ${bystanderToken}` },
            payload: { displayName: 'evil', projectId: teamProject.id },
        })
        expect(folderRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(folderRes.json<{ code: string }>().code).toBe('AUTHORIZATION')
    })

    it('VIEWER project_member cannot hit an endpoint requiring WRITE_FLOW (PERMISSION_DENIED)', async () => {
        const adminCtx = await createTestContext(app!)
        const createRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        const viewerRole = await db.findOneByOrFail<{ id: string }>('project_role', {
            platformId: adminCtx.platform.id,
            name: DefaultProjectRole.VIEWER,
            type: RoleType.DEFAULT,
        })

        const { mockUser: viewer } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        await db.save('project_member', {
            id: apId(),
            userId: viewer.id,
            projectId: teamProject.id,
            projectRoleId: viewerRole.id,
            platformId: adminCtx.platform.id,
        })
        const viewerToken = await generateMockToken({
            id: viewer.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const folderRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/folders',
            headers: { authorization: `Bearer ${viewerToken}` },
            payload: { displayName: 'nope', projectId: teamProject.id },
        })
        expect(folderRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(folderRes.json<{ code: string, params: { userId: string, projectId: string } }>()).toMatchObject({
            code: 'PERMISSION_DENIED',
            params: { userId: viewer.id, projectId: teamProject.id },
        })
    })

    it('Non-member on the same platform cannot invite themselves as ADMIN to another user\'s team project', async () => {
        const adminCtx = await createTestContext(app!)
        const createRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        const { mockUser: attacker } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const attackerToken = await generateMockToken({
            id: attacker.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const inviteRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${attackerToken}` },
            payload: {
                email: 'attacker+self@example.com',
                type: InvitationType.PROJECT,
                projectId: teamProject.id,
                projectRole: DefaultProjectRole.ADMIN,
                platformRole: null,
            },
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(inviteRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')

        // No project_member row was created for the attacker
        const membership = await db.findOneBy('project_member', {
            userId: attacker.id,
            projectId: teamProject.id,
        })
        expect(membership).toBeNull()
    })

    it('VIEWER project_member (no WRITE_INVITATION) cannot invite other users to the team project', async () => {
        const adminCtx = await createTestContext(app!)
        const createRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        const viewerRole = await db.findOneByOrFail<{ id: string }>('project_role', {
            platformId: adminCtx.platform.id,
            name: DefaultProjectRole.VIEWER,
            type: RoleType.DEFAULT,
        })

        const { mockUser: viewer } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        await db.save('project_member', {
            id: apId(),
            userId: viewer.id,
            projectId: teamProject.id,
            projectRoleId: viewerRole.id,
            platformId: adminCtx.platform.id,
        })
        const viewerToken = await generateMockToken({
            id: viewer.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const inviteRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${viewerToken}` },
            payload: {
                email: 'newcomer@example.com',
                type: InvitationType.PROJECT,
                projectId: teamProject.id,
                projectRole: DefaultProjectRole.EDITOR,
                platformRole: null,
            },
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(inviteRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    })

    it('Non-member cannot list invitations of another user\'s team project (GET /v1/user-invitations)', async () => {
        const adminCtx = await createTestContext(app!)
        const createRes = await adminCtx.post('/v1/projects', {
            displayName: faker.animal.bird(),
            externalId: null,
            metadata: null,
            maxConcurrentJobs: null,
        })
        expect(createRes.statusCode).toBe(StatusCodes.CREATED)
        const teamProject = createRes.json<ProjectWithLimits>()

        // Owner sends an invitation so there's something to (attempt to) enumerate
        const invite = await adminCtx.post('/v1/user-invitations', {
            email: `victim+${Date.now()}@example.com`,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
            platformRole: null,
        })
        expect(invite.statusCode).toBe(StatusCodes.CREATED)

        const { mockUser: attacker } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const attackerToken = await generateMockToken({
            id: attacker.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const listRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/user-invitations?type=${InvitationType.PROJECT}&projectId=${teamProject.id}`,
            headers: { authorization: `Bearer ${attackerToken}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(listRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    })

    it('Non-privileged USER cannot list platform-scope invitations (GET /v1/user-invitations?type=PLATFORM)', async () => {
        const adminCtx = await createTestContext(app!)
        const { mockUser: bystander } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const bystanderToken = await generateMockToken({
            id: bystander.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const listRes = await app!.inject({
            method: 'GET',
            url: `/api/v1/user-invitations?type=${InvitationType.PLATFORM}`,
            headers: { authorization: `Bearer ${bystanderToken}` },
        })
        expect(listRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(listRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    })

    it('Non-privileged USER cannot create a platform invitation (privilege escalation guard)', async () => {
        const adminCtx = await createTestContext(app!)
        const { mockUser: attacker } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.MEMBER,
            },
        })
        const attackerToken = await generateMockToken({
            id: attacker.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const inviteRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${attackerToken}` },
            payload: {
                email: `escalate-${apId()}@qadam.test`,
                type: InvitationType.PLATFORM,
                platformRole: PlatformRole.ADMIN,
            },
        })

        expect(inviteRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(inviteRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    })

    it('OPERATOR cannot create a platform invitation (role-minting is ADMIN-only)', async () => {
        const adminCtx = await createTestContext(app!)
        const { mockUser: operator } = await mockBasicUser({
            user: {
                platformId: adminCtx.platform.id,
                platformRole: PlatformRole.OPERATOR,
            },
        })
        const operatorToken = await generateMockToken({
            id: operator.id,
            type: PrincipalType.USER,
            platform: { id: adminCtx.platform.id },
        })

        const inviteRes = await app!.inject({
            method: 'POST',
            url: '/api/v1/user-invitations',
            headers: { authorization: `Bearer ${operatorToken}` },
            payload: {
                email: `escalate-${apId()}@qadam.test`,
                type: InvitationType.PLATFORM,
                platformRole: PlatformRole.ADMIN,
            },
        })

        expect(inviteRes.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(inviteRes.json<{ code: string }>().code).toBe('PERMISSION_DENIED')
    })

    it('Platform admin can create a platform invitation', async () => {
        const adminCtx = await createTestContext(app!)

        const inviteRes = await adminCtx.post('/v1/user-invitations', {
            email: `member-${apId()}@qadam.test`,
            type: InvitationType.PLATFORM,
            platformRole: PlatformRole.MEMBER,
        })

        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
    })
})
