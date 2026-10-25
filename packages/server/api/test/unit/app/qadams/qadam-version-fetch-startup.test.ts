import { FlowVersionState } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runExclusive = vi.fn()
const mockPlatformsGetAll = vi.fn()
const mockGetProjectIdsByPlatform = vi.fn()
const mockFlowRepoFind = vi.fn()
const mockFlowVersionRepoFind = vi.fn()
const mockFetchMissingPins = vi.fn()

vi.mock('../../../../src/app/database/redis-connections', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/app/database/redis-connections')>()
    return {
        ...actual,
        distributedLock: () => ({ runExclusive: (params: { fn: () => Promise<unknown> }) => runExclusive(params) }),
    }
})

vi.mock('../../../../src/app/platform/platform.service', () => ({
    platformService: () => ({ getAll: (...args: unknown[]) => mockPlatformsGetAll(...args) }),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: () => ({ getProjectIdsByPlatform: (...args: unknown[]) => mockGetProjectIdsByPlatform(...args) }),
}))

vi.mock('../../../../src/app/flows/flow/flow.repo', () => ({
    flowRepo: () => ({ find: (...args: unknown[]) => mockFlowRepoFind(...args) }),
}))

vi.mock('../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionRepo: () => ({ find: (...args: unknown[]) => mockFlowVersionRepoFind(...args) }),
}))

vi.mock('../../../../src/app/qadams/fetch/qadam-version-fetch', () => ({
    qadamVersionFetch: () => ({ fetchMissingPins: (...args: unknown[]) => mockFetchMissingPins(...args) }),
}))

import { qadamVersionFetchStartup } from '../../../../src/app/qadams/fetch/qadam-version-fetch-startup'

const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger

function qadamStep({ name = 'step_1', qadamName = '@aiqadam/qadam-csv', qadamVersion = '0.6.0' } = {}) {
    return { type: 'PIECE', name, settings: { qadamName, qadamVersion } }
}

function flowVersion({ id, trigger, state = FlowVersionState.DRAFT }: { id: string, trigger: unknown, state?: FlowVersionState }) {
    return { id, state, trigger }
}

beforeEach(() => {
    vi.clearAllMocks()
    runExclusive.mockImplementation(async ({ fn }: { fn: () => Promise<unknown> }) => fn())
    mockPlatformsGetAll.mockResolvedValue([])
    mockGetProjectIdsByPlatform.mockResolvedValue([])
    mockFlowRepoFind.mockResolvedValue([])
    mockFlowVersionRepoFind.mockResolvedValue([])
    mockFetchMissingPins.mockResolvedValue({ attempted: 0, fetched: 0, failed: 0 })
})

describe('qadamVersionFetchStartup.run', () => {
    it('does nothing when there are no platforms', async () => {
        await qadamVersionFetchStartup({ log }).run()

        expect(runExclusive).toHaveBeenCalledWith(expect.objectContaining({ key: 'qadam-version-fetch-startup' }))
        expect(mockFetchMissingPins).not.toHaveBeenCalled()
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ platforms: 0, flows: 0, fetched: 0, failed: 0 }), expect.any(String))
    })

    it('collects a platform\'s distinct pins across its projects\' drafts and published versions, and fetches them', async () => {
        mockPlatformsGetAll.mockResolvedValue([{ id: 'platform-1' }])
        mockGetProjectIdsByPlatform.mockResolvedValue(['project-1'])
        mockFlowRepoFind.mockResolvedValue([{ id: 'flow-1', publishedVersionId: 'fv-published' }])
        mockFlowVersionRepoFind.mockImplementation(async ({ where }: { where: { state?: FlowVersionState, id?: unknown } }) => {
            if (where.state === FlowVersionState.DRAFT) {
                return [flowVersion({ id: 'fv-draft', trigger: qadamStep({ qadamVersion: '0.6.0' }) })]
            }
            return [flowVersion({ id: 'fv-published', state: FlowVersionState.LOCKED, trigger: qadamStep({ qadamVersion: '0.6.0' }) })]
        })
        mockFetchMissingPins.mockResolvedValue({ attempted: 1, fetched: 1, failed: 0 })

        await qadamVersionFetchStartup({ log }).run()

        expect(mockFetchMissingPins).toHaveBeenCalledWith({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: 'platform-1' })
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ platforms: 1, flows: 2, fetched: 1, failed: 0 }), expect.any(String))
    })

    it('skips a flow version with no qadam steps: nothing is fetched for it', async () => {
        mockPlatformsGetAll.mockResolvedValue([{ id: 'platform-1' }])
        mockGetProjectIdsByPlatform.mockResolvedValue(['project-1'])
        mockFlowRepoFind.mockResolvedValue([{ id: 'flow-1', publishedVersionId: null }])
        mockFlowVersionRepoFind.mockImplementation(async ({ where }: { where: { state?: FlowVersionState } }) =>
            where.state === FlowVersionState.DRAFT ? [flowVersion({ id: 'fv-draft', trigger: { type: 'CODE', name: 'step_1', settings: {} } })] : [])

        await qadamVersionFetchStartup({ log }).run()

        expect(mockFetchMissingPins).not.toHaveBeenCalled()
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ flows: 0 }), expect.any(String))
    })

    it('folds a batch\'s individual pin-fetch failures into the boot-level failed count, not just platform/project-lookup failures', async () => {
        mockPlatformsGetAll.mockResolvedValue([{ id: 'platform-1' }])
        mockGetProjectIdsByPlatform.mockResolvedValue(['project-1'])
        mockFlowRepoFind.mockResolvedValue([{ id: 'flow-1', publishedVersionId: null }])
        mockFlowVersionRepoFind.mockImplementation(async ({ where }: { where: { state?: FlowVersionState } }) =>
            where.state === FlowVersionState.DRAFT ? [flowVersion({ id: 'fv-draft', trigger: qadamStep() })] : [])
        mockFetchMissingPins.mockResolvedValue({ attempted: 3, fetched: 1, failed: 2 })

        await qadamVersionFetchStartup({ log }).run()

        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ fetched: 1, failed: 2 }), expect.any(String))
    })

    it('counts an unreadable project as a failure and still fetches the other projects\' pins', async () => {
        mockPlatformsGetAll.mockResolvedValue([{ id: 'platform-1' }])
        mockGetProjectIdsByPlatform.mockResolvedValue(['project-bad', 'project-good'])
        mockFlowRepoFind.mockImplementation(async ({ where }: { where: { projectId: string } }) => {
            if (where.projectId === 'project-bad') {
                throw new Error('connection reset')
            }
            return [{ id: 'flow-1', publishedVersionId: null }]
        })
        mockFlowVersionRepoFind.mockImplementation(async ({ where }: { where: { state?: FlowVersionState } }) =>
            where.state === FlowVersionState.DRAFT ? [flowVersion({ id: 'fv-draft', trigger: qadamStep() })] : [])

        await qadamVersionFetchStartup({ log }).run()

        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ platformId: 'platform-1', projectId: 'project-bad' }), expect.any(String))
        expect(mockFetchMissingPins).toHaveBeenCalledWith({ pins: ['@aiqadam/qadam-csv@0.6.0'], platformId: 'platform-1' })
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ failed: 1 }), expect.any(String))
    })

    it('counts a platform whose projects cannot be listed as a failure, and skips it', async () => {
        mockPlatformsGetAll.mockResolvedValue([{ id: 'platform-1' }])
        mockGetProjectIdsByPlatform.mockRejectedValue(new Error('statement timeout'))

        await qadamVersionFetchStartup({ log }).run()

        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ platformId: 'platform-1' }), expect.any(String))
        expect(mockFetchMissingPins).not.toHaveBeenCalled()
        expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ failed: 1 }), expect.any(String))
    })

    it('never throws: a failure inside the locked pass is logged and run() resolves', async () => {
        runExclusive.mockRejectedValue(new Error('could not acquire the lock'))

        await expect(qadamVersionFetchStartup({ log }).run()).resolves.toBeUndefined()
        expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ error: 'could not acquire the lock' }), expect.any(String))
    })
})
