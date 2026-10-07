import { apId, DefaultProjectRole, ErrorCode, FederatedIdentityProvider, InvitationStatus, InvitationType, PlatformRole, ProjectWithLimits, QadamFlowError, tryCatch, UserIdentity, UserIdentityProvider, UserInvitationWithLink, UserStatus } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import pino from 'pino'
import { authenticationService } from '../../../../src/app/authentication/authentication.service'
import { userFederatedIdentityService } from '../../../../src/app/authentication/federated-identity/user-federated-identity-service'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { userService } from '../../../../src/app/user/user-service'
import { userInvitationsService } from '../../../../src/app/user-invitations/user-invitation.service'
import { createMockProjectRole, mockAndSaveBasicSetup, mockBasicUser } from '../../../helpers/mocks'
import { createServiceContext, createTestContext } from '../../../helpers/test-context'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// app-sec (round 2): reverse-direction identity squatting. An LDAP identity's standing access to a
// platform must always be provable by a `user_federated_identity` row on *that* platform — proof
// it actually signed in through that platform's own directory — never merely by the existence of a
// `user` row, which an invitation or a platform switch can otherwise create/reach with no directory
// involvement at all. These tests exercise the guards directly against real Postgres, without going
// through the LDAP wire protocol (irrelevant to what is under test here); the invitation-eligibility
// test at the end goes through the HTTP create path, so `setupTestEnvironment`'s app is captured for it.
const log = pino({ level: 'silent' })

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
})

async function createLdapIdentityWithFederatedRowOnPlatform(platformId: string): Promise<{ identityId: string, userId: string }> {
    const identity = await userIdentityService(log).create({
        email: 'directory-user@example.com',
        firstName: 'Directory',
        lastName: 'User',
        password: apId(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
    const user = await userService(log).getOrCreateWithProject({ identity, platformId })
    await userFederatedIdentityService(log).create({
        platformId,
        userId: user.id,
        provider: FederatedIdentityProvider.LDAP,
        subject: '11111111-1111-1111-1111-111111111111',
    })
    return { identityId: identity.id, userId: user.id }
}

describe('Reverse-direction LDAP identity squatting guards', () => {
    it('provisionUserInvitation refuses to grant a new platform to an LDAP identity with no federated row there', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const platformB = await mockAndSaveBasicSetup()
        const { identityId } = await createLdapIdentityWithFederatedRowOnPlatform(platformA.mockPlatform.id)

        await databaseConnection().getRepository('user_invitation').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            email: 'directory-user@example.com',
            platformId: platformB.mockPlatform.id,
            type: InvitationType.PLATFORM,
            platformRole: PlatformRole.ADMIN,
            projectId: null,
            projectRoleId: null,
            status: InvitationStatus.ACCEPTED,
        })

        await userInvitationsService(log).provisionUserInvitation({ email: 'directory-user@example.com' })

        const grantedUser = await userService(log).getOneByIdentityAndPlatform({ identityId, platformId: platformB.mockPlatform.id })
        expect(grantedUser).toBeNull()
    })

    it('provisionUserInvitation still grants a non-LDAP identity access the normal way (control)', async () => {
        const platformB = await mockAndSaveBasicSetup()
        const identity = await userIdentityService(log).create({
            email: 'local-user@example.com',
            firstName: 'Local',
            lastName: 'User',
            password: apId(),
            provider: UserIdentityProvider.EMAIL,
            verified: true,
            trackEvents: false,
            newsLetter: false,
        })

        await databaseConnection().getRepository('user_invitation').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            email: 'local-user@example.com',
            platformId: platformB.mockPlatform.id,
            type: InvitationType.PLATFORM,
            platformRole: PlatformRole.ADMIN,
            projectId: null,
            projectRoleId: null,
            status: InvitationStatus.ACCEPTED,
        })

        await userInvitationsService(log).provisionUserInvitation({ email: 'local-user@example.com' })

        const grantedUser = await userService(log).getOneByIdentityAndPlatform({ identityId: identity.id, platformId: platformB.mockPlatform.id })
        expect(grantedUser).not.toBeNull()
    })

    // Positive control for the guard above: a PROJECT invitation on the *same* platform an LDAP
    // identity already has a federated row on must still be applied normally — the guard exists to
    // stop a *new* platform being granted with no directory involvement, not to block legitimate
    // project-membership grants on a platform the identity is already eligible for.
    it('provisionUserInvitation applies a same-platform PROJECT invitation for an LDAP identity with a federated row there', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const { identityId } = await createLdapIdentityWithFederatedRowOnPlatform(platformA.mockPlatform.id)
        const projectRole = createMockProjectRole({ platformId: platformA.mockPlatform.id })
        await databaseConnection().getRepository('project_role').save(projectRole)

        await databaseConnection().getRepository('user_invitation').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            email: 'directory-user@example.com',
            platformId: platformA.mockPlatform.id,
            type: InvitationType.PROJECT,
            platformRole: null,
            projectId: platformA.mockProject.id,
            projectRoleId: projectRole.id,
            status: InvitationStatus.ACCEPTED,
        })

        await userInvitationsService(log).provisionUserInvitation({ email: 'directory-user@example.com' })

        const grantedUser = await userService(log).getOneByIdentityAndPlatform({ identityId, platformId: platformA.mockPlatform.id })
        expect(grantedUser).not.toBeNull()
        const membership = await databaseConnection().getRepository('project_member').findOneBy({
            userId: grantedUser!.id,
            projectId: platformA.mockProject.id,
        })
        expect(membership).not.toBeNull()
        expect(membership?.projectRoleId).toBe(projectRole.id)
    })

    it('switchPlatform refuses a platform whose user row has no federated row for an LDAP identity', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const platformB = await mockAndSaveBasicSetup()
        const { identityId } = await createLdapIdentityWithFederatedRowOnPlatform(platformA.mockPlatform.id)

        // Simulates a `user` row reached by some means other than this platform's own LDAP sign-in
        // (e.g. a pre-fix invitation grant) — no `user_federated_identity` row backs it.
        await databaseConnection().getRepository('user').save({
            id: apId(),
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            status: UserStatus.ACTIVE,
            platformRole: PlatformRole.ADMIN,
            identityId,
            platformId: platformB.mockPlatform.id,
        })

        const { error } = await tryCatch(() => authenticationService(log).switchPlatform({
            identityId,
            platformId: platformB.mockPlatform.id,
        }))

        expect(error).toBeInstanceOf(QadamFlowError)
        expect(error instanceof QadamFlowError ? error.error.code : undefined).toBe(ErrorCode.AUTHORIZATION)
    })

    it('switchPlatform succeeds once a federated row backs the target platform\'s user row', async () => {
        const platformA = await mockAndSaveBasicSetup()
        const platformB = await mockAndSaveBasicSetup()
        const { identityId } = await createLdapIdentityWithFederatedRowOnPlatform(platformA.mockPlatform.id)

        const userId = apId()
        await databaseConnection().getRepository('user').save({
            id: userId,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            status: UserStatus.ACTIVE,
            platformRole: PlatformRole.ADMIN,
            identityId,
            platformId: platformB.mockPlatform.id,
        })
        await userFederatedIdentityService(log).create({
            platformId: platformB.mockPlatform.id,
            userId,
            provider: FederatedIdentityProvider.LDAP,
            subject: '33333333-3333-3333-3333-333333333333',
        })

        const response = await authenticationService(log).switchPlatform({
            identityId,
            platformId: platformB.mockPlatform.id,
        })

        expect(response.id).toBe(userId)
    })

    // The create path must not report a false "added": a user row alone used to be enough for
    // `shouldAutoAcceptInvitation`, but provisioning then refuses the directory-minted identity, so
    // the invitation was marked ACCEPTED with no membership and no link. It must fall back to
    // PENDING + link instead (see `isEligibleForProvisioning`).
    it('creating a project invitation for an LDAP identity with no federated row stays PENDING with a link', async () => {
        const ctx = await createTestContext(app!)
        const teamProject = await createTeamProject(ctx)
        const identity = await createIneligibleDirectoryIdentity(ctx.platform.id)

        const inviteRes = await ctx.post('/v1/user-invitations', {
            email: identity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        const invitation = inviteRes.json<UserInvitationWithLink>()
        expect(invitation.status).toBe(InvitationStatus.PENDING)
        expect(invitation.link).toBeTruthy()

        const persisted = await databaseConnection().getRepository('user_invitation').findOneBy({
            email: identity.email,
            platformId: ctx.platform.id,
            projectId: teamProject.id,
        })
        expect(persisted?.status).toBe(InvitationStatus.PENDING)
    })

    // A SERVICE (API-key) caller is a platform admin and still auto-accepts normally, but it must not
    // be a second door to the same false ACCEPTED for a directory identity this platform cannot
    // provision.
    it('a SERVICE caller also falls back to PENDING for an ineligible directory identity', async () => {
        const ctx = await createTestContext(app!)
        const serviceCtx = await createServiceContext(app!, ctx)
        const teamProject = await createTeamProject(ctx)
        const identity = await createIneligibleDirectoryIdentity(ctx.platform.id)

        const inviteRes = await serviceCtx.post('/v1/user-invitations', {
            email: identity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        const invitation = inviteRes.json<UserInvitationWithLink>()
        expect(invitation.status).toBe(InvitationStatus.PENDING)
        expect(invitation.link).toBeTruthy()
    })

    // Positive control for the SERVICE path above: narrowing the guard must not turn every
    // SERVICE-created invitation into a pending one.
    it('a SERVICE caller still auto-accepts a project invitation for an eligible user', async () => {
        const ctx = await createTestContext(app!)
        const serviceCtx = await createServiceContext(app!, ctx)
        const teamProject = await createTeamProject(ctx)
        const { mockUserIdentity } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })

        const inviteRes = await serviceCtx.post('/v1/user-invitations', {
            email: mockUserIdentity.email,
            type: InvitationType.PROJECT,
            projectId: teamProject.id,
            projectRole: DefaultProjectRole.EDITOR,
        })
        expect(inviteRes.statusCode).toBe(StatusCodes.CREATED)
        expect(inviteRes.json<UserInvitationWithLink>().status).toBe(InvitationStatus.ACCEPTED)
    })
})

async function createTeamProject(ctx: Awaited<ReturnType<typeof createTestContext>>): Promise<ProjectWithLimits> {
    const res = await ctx.post('/v1/projects', {
        displayName: 'Invitation eligibility',
        externalId: null,
        metadata: null,
        maxConcurrentJobs: null,
    })
    expect(res.statusCode).toBe(StatusCodes.CREATED)
    return res.json<ProjectWithLimits>()
}

// An LDAP identity with a `user` row on the platform but no `user_federated_identity` row there —
// the state `isEligibleForInvitationProvisioning` refuses.
async function createIneligibleDirectoryIdentity(platformId: string): Promise<UserIdentity> {
    const identity = await userIdentityService(log).create({
        email: `directory-no-row-${apId()}@example.com`,
        firstName: 'No',
        lastName: 'Row',
        password: apId(),
        provider: UserIdentityProvider.LDAP,
        verified: true,
        trackEvents: false,
        newsLetter: false,
    })
    await userService(log).getOrCreateWithProject({ identity, platformId })
    return identity
}
