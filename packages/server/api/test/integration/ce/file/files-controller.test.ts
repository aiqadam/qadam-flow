import { apId, ErrorCode, FileType, PrincipalType } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { vi } from 'vitest'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { filesService } from '../../../../src/app/file/files-service'
import { generateMockToken } from '../../../helpers/auth'
import { createMockProject, mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Files Controller', () => {
    describe('PUT /v1/files/:fileId', () => {
        it('proxies the body, saves the file, and returns a readUrl + X-AP-File-Read-Url header', async () => {
            vi.useFakeTimers({ shouldAdvanceTime: true })
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
            try {
                const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
                const engineToken = await generateMockToken({
                    type: PrincipalType.ENGINE,
                    id: apId(),
                    projectId: mockProject.id,
                    platform: { id: mockPlatform.id },
                })
                const fileId = apId()
                const body = Buffer.from('hello world from a step file')

                const response = await app!.inject({
                    method: 'PUT',
                    url: `/api/v1/files/${fileId}`,
                    query: { token: engineToken },
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-ap-file-type': FileType.FLOW_STEP_FILE,
                        'x-ap-file-name': 'hello.txt',
                    },
                    payload: body,
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                const json = response?.json()
                expect(json.fileId).toBe(fileId)
                expect(json.readUrl).toContain(`/v1/files/${fileId}?token=`)
                expect(response?.headers['x-ap-file-read-url']).toBe(json.readUrl)
            }
            finally {
                vi.useRealTimers()
            }
        })

        it('returns a worker-reachable readUrl built from AP_INTERNAL_URL, not the public frontend host', async () => {
            const constructReadUrlSpy = vi.spyOn(filesService, 'constructReadUrl')
            const previousInternalUrl = process.env.AP_INTERNAL_URL
            process.env.AP_INTERNAL_URL = 'http://qadam-flow-app'
            try {
                const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
                const engineToken = await generateMockToken({
                    type: PrincipalType.ENGINE,
                    id: apId(),
                    projectId: mockProject.id,
                    platform: { id: mockPlatform.id },
                })
                const fileId = apId()

                const response = await app!.inject({
                    method: 'PUT',
                    url: `/api/v1/files/${fileId}`,
                    query: { token: engineToken },
                    headers: {
                        'content-type': 'application/octet-stream',
                        'x-ap-file-type': FileType.FLOW_STEP_FILE,
                        'x-ap-file-name': 'hello.txt',
                    },
                    payload: Buffer.from('internal host body'),
                })

                expect(response?.statusCode).toBe(StatusCodes.OK)
                const readUrl = response!.json().readUrl as string
                expect(new URL(readUrl).origin).toBe('http://qadam-flow-app')
                expect(response?.headers['x-ap-file-read-url']).toBe(readUrl)
                expect(constructReadUrlSpy).toHaveBeenCalledTimes(1)
            }
            finally {
                constructReadUrlSpy.mockRestore()
                if (previousInternalUrl === undefined) {
                    delete process.env.AP_INTERNAL_URL
                }
                else {
                    process.env.AP_INTERNAL_URL = previousInternalUrl
                }
            }
        })

        it('rejects a request whose token is not an engine principal', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const userToken = await generateMockToken({
                type: PrincipalType.USER,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
                tokenVersion: undefined,
            } as never)
            const fileId = apId()

            const response = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: userToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('x'),
            })

            expect(response?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        })

        it('rejects a request without X-AP-File-Type', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })

            const response = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${apId()}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                },
                payload: Buffer.from('x'),
            })

            expect([
                StatusCodes.BAD_REQUEST,
                StatusCodes.CONFLICT,
                StatusCodes.INTERNAL_SERVER_ERROR,
            ]).toContain(response?.statusCode)
        })

        it('refuses a PUT for a fileId owned by another project, and leaves the original row untouched (#517)', async () => {
            const { mockProject: projectB, mockPlatform: platformB } = await mockAndSaveBasicSetup()
            const engineTokenB = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: projectB.id,
                platform: { id: platformB.id },
            })
            const fileId = apId()

            const putAsB = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineTokenB },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('project B original content'),
            })
            expect(putAsB?.statusCode).toBe(StatusCodes.OK)
            const readUrl = putAsB!.json().readUrl as string
            const readTokenForB = new URL(readUrl).searchParams.get('token') as string

            const { mockProject: projectA, mockPlatform: platformA } = await mockAndSaveBasicSetup()
            const engineTokenA = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: projectA.id,
                platform: { id: platformA.id },
            })

            const putAsA = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineTokenA },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('project A takeover attempt'),
            })
            expect(putAsA?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(putAsA?.json().code).toBe(ErrorCode.AUTHORIZATION)

            const getAsOriginalReader = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: readTokenForB },
            })
            expect(getAsOriginalReader?.statusCode).toBe(StatusCodes.OK)
            expect(getAsOriginalReader?.rawPayload.toString('utf-8')).toBe('project B original content')

            // The row's projectId never became A's — A cannot look the id up as its own file either.
            const getAsA = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineTokenA },
            })
            expect(getAsA?.statusCode).toBe(StatusCodes.NOT_FOUND)
        })

        it('refuses a PUT for a fileId owned by another project on the SAME platform (#517)', async () => {
            // The S3 key template (`platform/${platformId}/${type}/${fileId}`) ignores
            // projectId, so two projects on the same platform would compute the identical
            // "fresh" key for the same fileId — this is the scenario the cross-platform test
            // above cannot exercise, since a fresh platformId always yields a fresh key path.
            const { mockProject: projectB, mockPlatform, mockOwner } = await mockAndSaveBasicSetup()
            const projectA = createMockProject({ ownerId: mockOwner.id, platformId: mockPlatform.id })
            await databaseConnection().getRepository('project').save(projectA)

            const engineTokenB = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: projectB.id,
                platform: { id: mockPlatform.id },
            })
            const engineTokenA = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: projectA.id,
                platform: { id: mockPlatform.id },
            })
            const fileId = apId()

            const putAsB = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineTokenB },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('project B original content'),
            })
            expect(putAsB?.statusCode).toBe(StatusCodes.OK)
            const readUrl = putAsB!.json().readUrl as string
            const readTokenForB = new URL(readUrl).searchParams.get('token') as string

            const putAsA = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineTokenA },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('project A takeover attempt'),
            })
            expect(putAsA?.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(putAsA?.json().code).toBe(ErrorCode.AUTHORIZATION)

            const getAsOriginalReader = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: readTokenForB },
            })
            expect(getAsOriginalReader?.statusCode).toBe(StatusCodes.OK)
            expect(getAsOriginalReader?.rawPayload.toString('utf-8')).toBe('project B original content')
        })

        it('lets the same project overwrite its own file id on re-upload (e.g. a run log progress update)', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })
            const fileId = apId()

            const first = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('first version'),
            })
            expect(first?.statusCode).toBe(StatusCodes.OK)

            const second = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: Buffer.from('second version'),
            })
            expect(second?.statusCode).toBe(StatusCodes.OK)

            const getResponse = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
            })
            expect(getResponse?.statusCode).toBe(StatusCodes.OK)
            expect(getResponse?.rawPayload.toString('utf-8')).toBe('second version')
        })

        it('rejects an unsupported X-AP-File-Type', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })

            const response = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${apId()}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.SAMPLE_DATA,
                },
                payload: Buffer.from('x'),
            })

            expect([
                StatusCodes.BAD_REQUEST,
                StatusCodes.CONFLICT,
                StatusCodes.INTERNAL_SERVER_ERROR,
            ]).toContain(response?.statusCode)
        })
    })

    describe('GET /v1/files/:fileId', () => {
        it('returns the bytes when called with the per-file FILE_READ token', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })
            const fileId = apId()
            const body = Buffer.from('downloadable content', 'utf-8')

            const putResponse = await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                },
                payload: body,
            })
            expect(putResponse?.statusCode).toBe(StatusCodes.OK)
            const readUrl = putResponse!.json().readUrl as string
            const readToken = new URL(readUrl).searchParams.get('token') as string

            const getResponse = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: readToken },
            })

            expect(getResponse?.statusCode).toBe(StatusCodes.OK)
            expect(getResponse?.rawPayload.toString('utf-8')).toBe('downloadable content')
        })

        it('returns the bytes when called with the engine principal token', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })
            const fileId = apId()
            const body = Buffer.from('engine read', 'utf-8')

            await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_RUN_LOG_SLICE,
                },
                payload: body,
            })

            const getResponse = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
            })

            expect(getResponse?.statusCode).toBe(StatusCodes.OK)
            expect(getResponse?.rawPayload.toString('utf-8')).toBe('engine read')
        })

        it('rejects a download with a read token bound to a different fileId', async () => {
            const otherFileReadUrl = await filesService.constructReadUrl({
                fileId: apId(),
                fileType: FileType.FLOW_STEP_FILE,
                platformId: null,
            })
            const otherFileToken = new URL(otherFileReadUrl).searchParams.get('token') as string

            const response = await app!.inject({
                method: 'GET',
                url: `/api/v1/files/${apId()}`,
                query: { token: otherFileToken },
            })

            expect(response?.statusCode).toBe(StatusCodes.UNAUTHORIZED)
        })
    })

    describe('GET /v1/step-files/signed (backward-compat alias)', () => {
        it('resolves an old-shape signed step-file URL', async () => {
            const { mockProject, mockPlatform } = await mockAndSaveBasicSetup()
            const engineToken = await generateMockToken({
                type: PrincipalType.ENGINE,
                id: apId(),
                projectId: mockProject.id,
                platform: { id: mockPlatform.id },
            })
            const fileId = apId()

            await app!.inject({
                method: 'PUT',
                url: `/api/v1/files/${fileId}`,
                query: { token: engineToken },
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-ap-file-type': FileType.FLOW_STEP_FILE,
                    'x-ap-file-name': 'attachment.bin',
                },
                payload: Buffer.from('legacy reader'),
            })

            const oldUrl = await filesService.constructReadUrl({
                fileId,
                fileType: FileType.FLOW_STEP_FILE,
                platformId: mockPlatform.id,
            })
            const readToken = new URL(oldUrl).searchParams.get('token') as string

            const response = await app!.inject({
                method: 'GET',
                url: '/api/v1/step-files/signed',
                query: { token: readToken },
            })

            // The alias either streams the bytes (DB storage) or redirects to S3.
            expect([StatusCodes.OK, StatusCodes.TEMPORARY_REDIRECT, StatusCodes.MOVED_TEMPORARILY]).toContain(response?.statusCode)
        })
    })
})
