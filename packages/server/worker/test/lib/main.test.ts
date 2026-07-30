import { afterEach, describe, expect, it, vi } from 'vitest'

const mockDeleteStaleCache = vi.fn().mockResolvedValue(undefined)
const mockWorkerStart = vi.fn().mockResolvedValue(undefined)
const mockWorkerStop = vi.fn().mockResolvedValue(undefined)

vi.mock('../../src/lib/cache/cache-paths', () => ({
    deleteStaleCache: (...args: unknown[]) => mockDeleteStaleCache(...args),
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
        start: (...args: unknown[]) => mockWorkerStart(...args),
        stop: (...args: unknown[]) => mockWorkerStop(...args),
    },
}))

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
})

describe('worker main', () => {
    it('kicks off stale cache eviction on startup without blocking job polling', async () => {
        await import('../../src/lib/main')

        // main() is fired at module scope and not awaited by the import itself;
        // flush the microtask queue so its body has run.
        await vi.waitFor(() => {
            expect(mockDeleteStaleCache).toHaveBeenCalledTimes(1)
        })
        expect(mockWorkerStart).toHaveBeenCalledTimes(1)
    })

    // The mock above returns WORKER, which is the only value that switches the health server on.
    // Asserting the argument is what makes that meaningful: without it, inverting the
    // `containerType === 'WORKER'` test in main.ts turns nothing red.
    it('starts the health server for a WORKER container', async () => {
        await import('../../src/lib/main')

        await vi.waitFor(() => {
            expect(mockWorkerStart).toHaveBeenCalledTimes(1)
        })
        expect(mockWorkerStart).toHaveBeenCalledWith(expect.objectContaining({ withHealthServer: true }))
    })
})
