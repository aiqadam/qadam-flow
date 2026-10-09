import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { main } from '../../src/lib/main'

const { mockDeleteStaleCache, mockWorkerStart, mockWorkerStop } = vi.hoisted(() => ({
    mockDeleteStaleCache: vi.fn(),
    mockWorkerStart: vi.fn(),
    mockWorkerStop: vi.fn(),
}))

vi.mock('../../src/lib/cache/cache-paths', () => ({
    deleteStaleCache: mockDeleteStaleCache,
}))

vi.mock('../../src/lib/config/configs', () => ({
    getApiUrl: vi.fn().mockReturnValue('http://api.local/api/'),
    getSocketUrl: vi.fn().mockReturnValue({ url: 'http://api.local', path: '/api/socket.io' }),
    system: {
        get: vi.fn().mockReturnValue(undefined),
        getOrThrow: vi.fn().mockReturnValue('worker-token'),
        // main() now resolves the container type through this rather than defaulting, so the mock
        // has to supply it — an unset value is a startup failure, not "both", since #211.
        getContainerType: vi.fn().mockReturnValue('WORKER'),
    },
    WorkerSystemProp: {
        CONTAINER_TYPE: 'AP_CONTAINER_TYPE',
        WORKER_TOKEN: 'AP_WORKER_TOKEN',
    },
}))

vi.mock('../../src/lib/config/logger', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

vi.mock('../../src/lib/worker', () => ({
    worker: {
        start: mockWorkerStart,
        stop: mockWorkerStop,
    },
}))

// main() needs only `eventLoopMonitor` from here. The real barrel pulls in all of server-utils and
// shared, and would leave a live event-loop histogram running after every test.
vi.mock('@aiqadam/server-utils', () => ({
    eventLoopMonitor: {
        start: vi.fn().mockReturnValue({ stop: vi.fn() }),
    },
}))

beforeEach(() => {
    vi.clearAllMocks()
    mockDeleteStaleCache.mockResolvedValue(undefined)
    mockWorkerStart.mockResolvedValue(undefined)
    mockWorkerStop.mockResolvedValue(undefined)
})

afterEach(() => {
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
})

describe('worker main', () => {
    it('kicks off stale cache eviction on startup without blocking job polling', async () => {
        // An eviction that never settles: if main() awaited it, this test would hang instead of
        // reaching worker.start().
        mockDeleteStaleCache.mockReturnValue(new Promise<never>(() => undefined))

        await main()

        expect(mockDeleteStaleCache).toHaveBeenCalledTimes(1)
        expect(mockWorkerStart).toHaveBeenCalledTimes(1)
    })

    // The mock above returns WORKER, which is the only value that switches the health server on.
    // Asserting the argument is what makes that meaningful: without it, inverting the
    // `containerType === 'WORKER'` test in main.ts turns nothing red.
    it('starts the health server for a WORKER container', async () => {
        await main()

        expect(mockWorkerStart).toHaveBeenCalledTimes(1)
        expect(mockWorkerStart).toHaveBeenCalledWith(expect.objectContaining({ withHealthServer: true }))
    })
})
