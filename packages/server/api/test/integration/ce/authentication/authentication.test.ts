import { Principal, Project } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import * as accessTokenManagerModule from '../../../../src/app/authentication/lib/access-token-manager'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import * as redisConnectionsModule from '../../../../src/app/database/redis-connections'
import * as projectServiceModule from '../../../../src/app/project/project-service'
import {
    createMockSignInRequest,
    createMockSignUpRequest,
} from '../../../helpers/mocks/authn'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
const originalAccessTokenManager = accessTokenManagerModule.accessTokenManager
const originalDistributedLock = redisConnectionsModule.distributedLock
const originalProjectService = projectServiceModule.projectService

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await cleanDatabase()
})

afterEach(() => {
    vi.restoreAllMocks()
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
        // points somewhere else — permanently unable to sign back in. A distributedLock keyed on
        // identityId around the whole claim serializes the two calls (the test after this one
        // covers the database doing the same with the lock out of the picture): whichever
        // runs second finds the row already claimed (platformId no longer null) and falls back to
        // inserting its own — the same per-call-own-row outcome the code had before the reuse
        // optimization, just now reached deliberately instead of by accident. This fires two
        // overlapping requests for real and asserts both platforms end up consistently owned rather
        // than one of them corrupted. The service layer is not mocked; the only stand-in is a
        // barrier at the authentication layer that makes the two claims overlap on every run (see
        // below).
        it('serializes two concurrent create-platform calls for the same onboarding identity instead of stranding one of them', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token

            // Both calls carry the same onboarding token, and the first claim to commit rotates the
            // identity's tokenVersion. A call that reaches authentication only after that commit is
            // rejected with SESSION_EXPIRED before its handler, and so the lock under test, ever
            // runs, which left whether the two claims overlapped at all to scheduling. Hold each
            // call just past authentication until both have passed it: both claims then reach
            // the lock together on every run.
            const authenticated = createArrivalBarrier({ parties: 2, timeoutMs: 10_000 })
            vi.spyOn(accessTokenManagerModule, 'accessTokenManager').mockImplementation((log) => {
                const real = originalAccessTokenManager(log)
                return {
                    ...real,
                    verifyPrincipal: async (token: string): Promise<Principal> => {
                        const principal = await real.verifyPrincipal(token)
                        await authenticated.arrive()
                        return principal
                    },
                }
            })

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
            // Checked first so that a request bypassing the spy, or failing authentication, reads
            // as a barrier timeout rather than as an unexplained 403 below.
            expect(
                authenticated.releasedByArrival(),
                'authentication barrier timed out after 10s: both create-platform calls must pass verifyPrincipal before either reaches the lock',
            ).toBe(true)
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

        // The claim must not rely on the distributed lock for its correctness: with the lock
        // reduced to a pass-through, two overlapping claims for the same onboarding identity must
        // still end the same way as when the lock serializes them — two platforms, each owned by
        // its own user row whose platformId points back at it, with no platform left without a
        // project. A barrier inside the pass-through starts both claims together on every run.
        it('keeps concurrent create-platform calls for the same onboarding identity consistent without the distributed lock', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token

            const claimsStarted = createArrivalBarrier({ parties: 2, timeoutMs: 10_000 })
            vi.spyOn(redisConnectionsModule, 'distributedLock').mockImplementation((log) => ({
                ...originalDistributedLock(log),
                runExclusive: async <T>({ fn }: { fn: (lockLostSignal: AbortSignal) => Promise<T> }): Promise<T> => {
                    await claimsStarted.arrive()
                    return fn(new AbortController().signal)
                },
            }))

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
            expect(
                claimsStarted.releasedByArrival(),
                'claim barrier timed out after 10s: both create-platform calls must reach the claim before either runs it',
            ).toBe(true)
            expect(responseA?.statusCode).toBe(StatusCodes.OK)
            expect(responseB?.statusCode).toBe(StatusCodes.OK)

            const platformIds = [responseA?.json()?.platformId, responseB?.json()?.platformId]
            expect(new Set(platformIds).size).toBe(2)

            const userRepo = databaseConnection().getRepository('user')
            const platformRepo = databaseConnection().getRepository('platform')
            const projectRepo = databaseConnection().getRepository('project')
            expect(await userRepo.count()).toBe(2)
            expect(await platformRepo.count()).toBe(2)
            expect(await projectRepo.count()).toBe(2)
            for (const platformId of platformIds) {
                const platform = await platformRepo.findOneByOrFail({ id: platformId })
                const owner = await userRepo.findOneByOrFail({ id: platform.ownerId })
                expect(owner.platformId).toBe(platformId)
                expect(owner.platformRole).toBe('ADMIN')
                expect(await projectRepo.countBy({ platformId, ownerId: owner.id })).toBe(1)
            }
        })

        it('commits none of the create-platform writes when a later step of the claim fails', async () => {
            // arrange
            const mockSignUpRequest = createMockSignUpRequest()
            const signUpResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/authentication/sign-up',
                body: mockSignUpRequest,
            })
            const onboardingToken = signUpResponse?.json()?.token
            const identityRepo = databaseConnection().getRepository('user_identity')
            const identityBefore = await identityRepo.findOneByOrFail({ email: mockSignUpRequest.email.toLocaleLowerCase().trim() })

            const projectServiceSpy = vi.spyOn(projectServiceModule, 'projectService').mockImplementation((log) => ({
                ...originalProjectService(log),
                create: async (): Promise<Project> => {
                    throw new Error('project creation failed')
                },
            }))

            // act
            const failedResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/platforms',
                headers: { authorization: `Bearer ${onboardingToken}` },
                body: { name: 'Acme' },
            })

            // assert
            expect(failedResponse?.statusCode).toBe(StatusCodes.INTERNAL_SERVER_ERROR)
            const userRepo = databaseConnection().getRepository('user')
            expect(await databaseConnection().getRepository('platform').count()).toBe(0)
            expect(await databaseConnection().getRepository('project').count()).toBe(0)
            const users = await userRepo.find()
            expect(users).toHaveLength(1)
            expect(users[0].platformId).toBeNull()
            const identityAfter = await identityRepo.findOneByOrFail({ id: identityBefore.id })
            expect(identityAfter.tokenVersion).toBe(identityBefore.tokenVersion)

            // The untouched onboarding row is still claimable once the failure is gone.
            projectServiceSpy.mockRestore()
            const retryResponse = await app?.inject({
                method: 'POST',
                url: '/api/v1/platforms',
                headers: { authorization: `Bearer ${onboardingToken}` },
                body: { name: 'Acme' },
            })
            expect(retryResponse?.statusCode).toBe(StatusCodes.OK)
            expect(await userRepo.count()).toBe(1)
            const owner = await userRepo.findOneByOrFail({ id: users[0].id })
            expect(owner.platformId).toBe(retryResponse?.json()?.platformId)
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

// Resolves every arrive() once `parties` callers have arrived, or once timeoutMs has passed, so a
// call that never arrives fails the assertions instead of hanging the test. releasedByArrival()
// tells the two apart: an arrival after the timeout does not count as a release.
function createArrivalBarrier({ parties, timeoutMs }: ArrivalBarrierParams): ArrivalBarrier {
    let arrived = 0
    let released = false
    let expired = false
    let release: () => void = () => undefined
    let expire: () => void = () => undefined
    const allArrived = new Promise<void>((resolve) => {
        release = resolve
    })
    const timedOut = new Promise<void>((resolve) => {
        expire = resolve
    })
    const timer = setTimeout(() => {
        expired = true
        expire()
    }, timeoutMs)
    timer.unref()
    return {
        arrive: async (): Promise<void> => {
            arrived += 1
            if (arrived >= parties && !released && !expired) {
                released = true
                clearTimeout(timer)
                release()
            }
            await Promise.race([allArrived, timedOut])
        },
        releasedByArrival: (): boolean => released,
    }
}

type ArrivalBarrierParams = {
    parties: number
    timeoutMs: number
}

type ArrivalBarrier = {
    arrive: () => Promise<void>
    releasedByArrival: () => boolean
}
