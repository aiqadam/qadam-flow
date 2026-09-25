import { apId, ErrorCode, FederatedIdentityProvider, InvitationStatus, InvitationType, PlatformRole, QadamFlowError, UserIdentityProvider, UserStatus } from '@aiqadam/shared'
import pino from 'pino'
import { authenticationService } from '../../../../src/app/authentication/authentication.service'
import { userFederatedIdentityService } from '../../../../src/app/authentication/federated-identity/user-federated-identity-service'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { userService } from '../../../../src/app/user/user-service'
import { userInvitationsService } from '../../../../src/app/user-invitations/user-invitation.service'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// app-sec (round 2): reverse-direction identity squatting. An LDAP identity's standing access to a
// platform must always be provable by a `user_federated_identity` row on *that* platform — proof
// it actually signed in through that platform's own directory — never merely by the existence of a
// `user` row, which an invitation or a platform switch can otherwise create/reach with no directory
// involvement at all. These tests exercise the two guards directly against real Postgres, without
// going through the LDAP wire protocol (irrelevant to what is under test here) — no HTTP layer is
// needed either, so `setupTestEnvironment`'s returned `FastifyInstance` is never used, only its
// side effect of bootstrapping the DB connection.
const log = pino({ level: 'silent' })

beforeAll(async () => {
    await setupTestEnvironment()
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

        const { error } = await authenticationService(log).switchPlatform({
            identityId,
            platformId: platformB.mockPlatform.id,
        }).then(() => ({ error: null as unknown })).catch((thrown: unknown) => ({ error: thrown }))

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
})
