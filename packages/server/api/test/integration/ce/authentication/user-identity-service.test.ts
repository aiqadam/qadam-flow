import { UserIdentityProvider } from '@aiqadam/shared'
import pino from 'pino'
import { userIdentityService } from '../../../../src/app/authentication/user-identity/user-identity-service'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { createMockUserIdentity } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

beforeAll(async () => {
    await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
})

describe('userIdentityService.updatePassword', () => {
    it('refuses to change the password of an LDAP-managed identity', async () => {
        const identity = createMockUserIdentity({ provider: UserIdentityProvider.LDAP })
        await databaseConnection().getRepository('user_identity').save(identity)

        const { error } = await userIdentityService(pino({ level: 'silent' })).updatePassword({ id: identity.id, newPassword: 'a-new-password' })
            .then(() => ({ error: null as unknown }))
            .catch((thrown: unknown) => ({ error: thrown }))

        expect(error).not.toBeNull()
        const unchanged = await databaseConnection().getRepository('user_identity').findOneByOrFail({ id: identity.id })
        expect(unchanged.password).toBe(identity.password)
    })

    it('changes the password of a local (EMAIL) identity', async () => {
        const identity = createMockUserIdentity({ provider: UserIdentityProvider.EMAIL })
        await databaseConnection().getRepository('user_identity').save(identity)

        await userIdentityService(pino({ level: 'silent' })).updatePassword({ id: identity.id, newPassword: 'a-new-password' })

        const updated = await databaseConnection().getRepository('user_identity').findOneByOrFail({ id: identity.id })
        expect(updated.password).not.toBe(identity.password)
    })
})
