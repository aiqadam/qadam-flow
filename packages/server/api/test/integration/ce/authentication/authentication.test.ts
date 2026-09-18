import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import {
    createMockSignInRequest,
    createMockSignUpRequest,
} from '../../../helpers/mocks/authn'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

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
describe('Authentication API', () => {
    describe('Sign up Endpoint', () => {
        it('Adds new user with onboarding token', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(responseBody?.id).toHaveLength(21)
            expect(responseBody?.verified).toBe(true)
            expect(responseBody?.email).toBe(mockSignUpRequest.email.toLocaleLowerCase().trim())
            expect(responseBody?.firstName).toBe(mockSignUpRequest.firstName)
            expect(responseBody?.lastName).toBe(mockSignUpRequest.lastName)
            expect(responseBody?.trackEvents).toBe(mockSignUpRequest.trackEvents)
            expect(responseBody?.newsLetter).toBe(mockSignUpRequest.newsLetter)
            expect(responseBody?.status).toBe('ACTIVE')
            expect(responseBody?.platformId).toBeNull()
            expect(responseBody?.externalId).toBe(null)
            expect(responseBody?.projectId).toBeNull()
            expect(responseBody?.token).toBeDefined()
        })

        it('Does not create project or platform on signup', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })

            // assert
            expect(response?.statusCode).toBe(StatusCodes.OK)

            const platformCount = await databaseConnection().getRepository('platform').count()
            const projectCount = await databaseConnection().getRepository('project').count()

            expect(platformCount).toBe(0)
            expect(projectCount).toBe(0)
        })

        // GET /v1/users/me for an ONBOARDING principal (platform-user-controller.ts) resolves by
        // identityId with platformId IS NULL. platform-user-community.test.ts covers that lookup
        // logic, but seeds its row via mockBasicUser, which inserts a User directly and does not
        // prove the real sign-up path ever creates one — it didn't: this exact gap 404'd every
        // fresh instance's first sign-up until the no-platform branch above started bootstrapping
        // the row. This test goes through the real endpoint both times, no direct DB seeding.
        it('lets the ONBOARDING principal from a fresh sign-up read its own record via /users/me', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token

            // act
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/users/me',
                headers: {
                    authorization: `Bearer ${onboardingToken}`,
                },
            })

            // assert
            expect(response?.statusCode).toBe(StatusCodes.OK)
            const responseBody = response?.json()
            expect(responseBody?.email).toBe(mockSignUpRequest.email.toLocaleLowerCase().trim())
            expect(responseBody?.platformId).toBeNull()
        })

        // createPlatformWithProject (platform.service.ts) reuses the platformId:null row the
        // no-platform branch above bootstraps, rather than inserting an orphaned second one for
        // the same identityId (nothing rejects a second insert — platformId:null rows aren't
        // constrained unique). This exercises the real sign-up -> create-platform chain to guard
        // that reuse, and that it lands on exactly one `user` row (userCount below).
        it('creates the platform on the row sign-up bootstrapped, without a duplicate-key error', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/platforms',
                headers: {
                    authorization: `Bearer ${onboardingToken}`,
                },
                body: { name: 'Acme' },
            })

            // assert
            expect(response?.statusCode).toBe(StatusCodes.OK)
            const responseBody = response?.json()
            expect(responseBody?.platformId).toBeDefined()

            const userCount = await databaseConnection().getRepository('user').count()
            expect(userCount).toBe(1)

            const meResponse = await app?.inject({
                method: 'GET',
                url: '/api/v1/users/me',
                headers: {
                    authorization: `Bearer ${responseBody.token}`,
                },
            })
            expect(meResponse?.statusCode).toBe(StatusCodes.OK)
            const meBody = meResponse?.json()
            expect(meBody?.platformId).toBe(responseBody.platformId)
            expect(meBody?.platformRole).toBe('ADMIN')
        })

        // createPlatformWithProject reuses the bootstrapped platformId:null row rather than
        // inserting a fresh one per call (see the test above), which means the read-and-promote is
        // no longer implicitly serialized by a unique-constraint violation on a second insert: two
        // concurrent calls for the same identity would otherwise both read the same row and both
        // promote it, leaving one platform's ownerId pointing at a user whose own platformId now
        // points somewhere else — permanently unable to sign back in. The fix is a distributedLock
        // keyed on identityId around the whole claim, which serializes the two calls: whichever
        // runs second finds the row already claimed (platformId no longer null) and falls back to
        // inserting its own — the same per-call-own-row outcome the code had before the reuse
        // optimization, just now reached deliberately instead of by accident. This fires two
        // overlapping requests for real (no service-layer mocking) and asserts both platforms end
        // up consistently owned rather than one of them corrupted.
        it('serializes two concurrent create-platform calls for the same onboarding identity instead of stranding one of them', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token

            // act
            const [responseA, responseB] = await Promise.all([
                app?.inject({
                    method: 'POST',
                    url: '/api/v1/platforms',
                    headers: { authorization: `Bearer ${onboardingToken}` },
                    body: { name: 'Acme A' },
                }),
                app?.inject({
                    method: 'POST',
                    url: '/api/v1/platforms',
                    headers: { authorization: `Bearer ${onboardingToken}` },
                    body: { name: 'Acme B' },
                }),
            ])

            // assert
            expect(responseA?.statusCode).toBe(StatusCodes.OK)
            expect(responseB?.statusCode).toBe(StatusCodes.OK)

            const platformIds = [responseA?.json()?.platformId, responseB?.json()?.platformId]
            expect(new Set(platformIds).size).toBe(2)

            // One claimed the bootstrapped row, the other fell back to inserting its own — two
            // distinct, each-consistently-owned users, not one row torn between two platforms.
            // Checked against the DB directly rather than by replaying each response's own token:
            // both calls set invalidatePreviousTokens, and that rotation is keyed on identityId
            // (shared across both platform-scoped user rows), so whichever call's promotion lands
            // second also invalidates the first call's already-returned token — expected, and
            // orthogonal to the thing under test here, which is data consistency, not token
            // lifetime.
            const userRepo = databaseConnection().getRepository('user')
            const platformRepo = databaseConnection().getRepository('platform')
            expect(await userRepo.count()).toBe(2)
            for (const platformId of platformIds) {
                const platform = await platformRepo.findOneByOrFail({ id: platformId })
                const owner = await userRepo.findOneByOrFail({ id: platform.ownerId })
                expect(owner.platformId).toBe(platformId)
                expect(owner.platformRole).toBe('ADMIN')
            }
        })
    })

    describe('Sign in Endpoint', () => {
        it('Logs in with onboarding token when no platform exists', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })

            const mockSignInRequest = createMockSignInRequest({
                email: mockSignUpRequest.email,
                password: mockSignUpRequest.password,
            })

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-in',
                body: mockSignInRequest,
            })

            // assert
            const responseBody = response?.json()

            expect(response?.statusCode).toBe(StatusCodes.OK)
            expect(responseBody?.platformId).toBeNull()
            expect(responseBody?.projectId).toBeNull()
            expect(responseBody?.token).toBeDefined()
        })

        it('Fails if password doesn\'t match', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()

            // First sign up the user
            await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })

            const mockSignInRequest = createMockSignInRequest({
                email: mockSignUpRequest.email,
                password: 'wrong password',
            })

            // act
            const response = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-in',
                body: mockSignInRequest,
            })

            // assert
            expect(response?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
            const responseBody = response?.json()
            expect(responseBody?.code).toBe('INVALID_CREDENTIALS')
        })
    })
})
