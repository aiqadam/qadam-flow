import { OtpState, OtpType, UserIdentity } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'
import { createMockOtp, createMockUserIdentity } from '../../../helpers/mocks'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('otp').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('flag').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('project').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('platform').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('user').createQueryBuilder().delete().execute()
    await databaseConnection().getRepository('user_identity').createQueryBuilder().delete().execute()
})

async function saveIdentity(overrides?: Partial<UserIdentity>): Promise<UserIdentity> {
    const identity = createMockUserIdentity(overrides)
    await databaseConnection().getRepository('user_identity').save(identity)
    return identity
}

describe('Local Authn / OTP API', () => {
    describe('POST /v1/otp', () => {
        it('creates a pending OTP for an existing identity', async () => {
            const identity = await saveIdentity()

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/otp',
                body: { email: identity.email, type: OtpType.PASSWORD_RESET },
            })

            expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
            const otp = await databaseConnection().getRepository('otp').findOneBy({
                identityId: identity.id,
                type: OtpType.PASSWORD_RESET,
            })
            expect(otp?.state).toBe(OtpState.PENDING)
        })

        it('does not leak whether the email exists (no OTP, still 204)', async () => {
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/otp',
                body: { email: 'nobody@qadam.test', type: OtpType.PASSWORD_RESET },
            })

            expect(response?.statusCode).toBe(StatusCodes.NO_CONTENT)
            const count = await databaseConnection().getRepository('otp').count()
            expect(count).toBe(0)
        })
    })

    describe('POST /v1/authn/local/verify-email', () => {
        it('verifies the identity when the OTP matches', async () => {
            const identity = await saveIdentity({ verified: false })
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.EMAIL_VERIFICATION,
                state: OtpState.PENDING,
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/verify-email',
                body: { identityId: identity.id, otp: otp.value },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const updated = await databaseConnection().getRepository('user_identity').findOneBy({ id: identity.id })
            expect(updated?.verified).toBe(true)
            const confirmedOtp = await databaseConnection().getRepository('otp').findOneBy({ id: otp.id })
            expect(confirmedOtp?.state).toBe(OtpState.CONFIRMED)
        })

        it('does not leak the password hash or tokenVersion in the response', async () => {
            const identity = await saveIdentity({ verified: false })
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.EMAIL_VERIFICATION,
                state: OtpState.PENDING,
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/verify-email',
                body: { identityId: identity.id, otp: otp.value },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()
            expect(body.password).toBeUndefined()
            expect(body.tokenVersion).toBeUndefined()
        })

        it('rejects with INVALID_OTP (not 500) when no OTP exists for the identity', async () => {
            const identity = await saveIdentity({ verified: false })

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/verify-email',
                body: { identityId: identity.id, otp: 'any-value' },
            })

            expect(response?.statusCode).not.toBe(StatusCodes.INTERNAL_SERVER_ERROR)
            expect(response?.json().code).toBe('INVALID_OTP')
        })

        it('rejects a wrong OTP and leaves the identity unverified', async () => {
            const identity = await saveIdentity({ verified: false })
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.EMAIL_VERIFICATION,
                state: OtpState.PENDING,
                value: 'the-real-otp',
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/verify-email',
                body: { identityId: identity.id, otp: 'wrong-otp' },
            })

            expect(response?.statusCode).not.toBe(StatusCodes.OK)
            expect(response?.json().code).toBe('INVALID_OTP')
            const updated = await databaseConnection().getRepository('user_identity').findOneBy({ id: identity.id })
            expect(updated?.verified).toBe(false)
        })
    })

    describe('POST /v1/authn/local/reset-password', () => {
        it('changes the password when the OTP matches', async () => {
            const identity = await saveIdentity({ verified: true })
            const originalPassword = identity.password
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.PASSWORD_RESET,
                state: OtpState.PENDING,
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/reset-password',
                body: { identityId: identity.id, otp: otp.value, newPassword: 'NewStrongPassword123!' },
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const updated = await databaseConnection().getRepository('user_identity').findOneBy({ id: identity.id })
            expect(updated?.password).not.toBe(originalPassword)
        })

        it('rejects a wrong OTP and leaves the password unchanged', async () => {
            const identity = await saveIdentity({ verified: true })
            const originalPassword = identity.password
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.PASSWORD_RESET,
                state: OtpState.PENDING,
                value: 'the-real-otp',
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/reset-password',
                body: { identityId: identity.id, otp: 'wrong-otp', newPassword: 'NewStrongPassword123!' },
            })

            expect(response?.statusCode).not.toBe(StatusCodes.OK)
            expect(response?.json().code).toBe('INVALID_OTP')
            const updated = await databaseConnection().getRepository('user_identity').findOneBy({ id: identity.id })
            expect(updated?.password).toBe(originalPassword)
        })

        it('rejects a password that violates the strength policy', async () => {
            const identity = await saveIdentity({ verified: true })
            const otp = createMockOtp({
                identityId: identity.id,
                type: OtpType.PASSWORD_RESET,
                state: OtpState.PENDING,
            })
            await databaseConnection().getRepository('otp').save(otp)

            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authn/local/reset-password',
                body: { identityId: identity.id, otp: otp.value, newPassword: 'short' },
            })

            expect(response?.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })
    })
})
