import {
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
import { createMockProjectRole, createMockUserIdentity } from '../../helpers/mocks'
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

        // Seed an EDITOR role for User1's platform (roles aren't auto-seeded)
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
})
