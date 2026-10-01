import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jobTimings } from '../../../src/lib/execute/job-timings'
import type { SandboxManager } from '../../../src/lib/execute/sandbox-manager'
import type { Sandbox } from '../../../src/lib/sandbox/types'

function makeSandbox({ ready }: { ready: boolean }): Sandbox {
    return {
        id: 'sb-1',
        start: vi.fn().mockResolvedValue(undefined),
        execute: vi.fn().mockResolvedValue({ status: 'OK', logs: undefined }),
        shutdown: vi.fn().mockResolvedValue(undefined),
        isReady: vi.fn().mockReturnValue(ready),
        getPid: vi.fn().mockReturnValue(42),
        isBusy: vi.fn().mockReturnValue(false),
    }
}

function makeManager(sandbox: Sandbox): SandboxManager {
    return {
        acquire: vi.fn().mockReturnValue(sandbox),
        prewarm: vi.fn().mockResolvedValue(undefined),
        invalidate: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        markStale: vi.fn(),
        getActiveSandbox: vi.fn().mockReturnValue(null),
    }
}

function stubClock(readings: number[]): void {
    const spy = vi.spyOn(performance, 'now')
    for (const reading of readings) {
        spy.mockReturnValueOnce(reading)
    }
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never

describe('jobTimings', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reports nothing for a job that recorded no phase', () => {
        expect(jobTimings.create().summary()).toEqual({
            flowVersionMs: undefined,
            provisionMs: undefined,
            sandbox: undefined,
            sandboxStartMs: undefined,
            executeMs: undefined,
            executeCount: undefined,
        })
    })

    it('returns the measured value and records its duration, rounded', async () => {
        const timings = jobTimings.create()
        stubClock([100, 350.6])

        const value = await timings.measure({ phase: 'provision', fn: async () => 'done' })

        expect(value).toBe('done')
        expect(timings.summary().provisionMs).toBe(251)
    })

    it('records the phase of a call that threw, and rethrows', async () => {
        const timings = jobTimings.create()
        stubClock([0, 40])

        await expect(timings.measure({ phase: 'provision', fn: async () => {
            throw new Error('ENOENT')
        } })).rejects.toThrow('ENOENT')

        expect(timings.summary().provisionMs).toBe(40)
    })

    it('sums a phase that ran more than once and counts executions', async () => {
        const timings = jobTimings.create()
        stubClock([0, 10, 20, 50])

        await timings.measure({ phase: 'execute', fn: async () => undefined })
        await timings.measure({ phase: 'execute', fn: async () => undefined })

        expect(timings.summary()).toMatchObject({ executeMs: 40, executeCount: 2 })
    })

    describe('instrumentSandboxManager', () => {
        it('marks the sandbox cold when the slot has no live process, and times its start', async () => {
            const timings = jobTimings.create()
            const manager = jobTimings.instrumentSandboxManager({ sandboxManager: makeManager(makeSandbox({ ready: false })), timings })
            stubClock([0, 2800])

            await manager.acquire({ log, apiClient: {} as never }).start({ flowVersionId: 'fv-1', platformId: 'p-1', mounts: [] })

            expect(timings.summary()).toMatchObject({ sandbox: 'cold', sandboxStartMs: 2800 })
        })

        it('marks the sandbox warm when the slot reuses a live process', async () => {
            const timings = jobTimings.create()
            const manager = jobTimings.instrumentSandboxManager({ sandboxManager: makeManager(makeSandbox({ ready: true })), timings })

            await manager.acquire({ log, apiClient: {} as never }).start({ flowVersionId: 'fv-1', platformId: 'p-1', mounts: [] })

            expect(timings.summary().sandbox).toBe('warm')
        })

        it('keeps a job cold once any of its sandbox starts was cold', () => {
            const timings = jobTimings.create()

            timings.recordSandbox('cold')
            timings.recordSandbox('warm')

            expect(timings.summary().sandbox).toBe('cold')
        })

        it('times execute and passes the engine result through untouched', async () => {
            const timings = jobTimings.create()
            const sandbox = makeSandbox({ ready: true })
            const manager = jobTimings.instrumentSandboxManager({ sandboxManager: makeManager(sandbox), timings })
            stubClock([1000, 1750])

            const result = await manager.acquire({ log, apiClient: {} as never }).execute('EXECUTE_FLOW' as never, {} as never, { timeoutInSeconds: 60 })

            expect(result).toEqual({ status: 'OK', logs: undefined })
            expect(sandbox.execute).toHaveBeenCalledWith('EXECUTE_FLOW', {}, { timeoutInSeconds: 60 })
            expect(timings.summary()).toMatchObject({ executeMs: 750, executeCount: 1 })
        })

        it('delegates the lifecycle calls to the real manager', async () => {
            const inner = makeManager(makeSandbox({ ready: true }))
            const manager = jobTimings.instrumentSandboxManager({ sandboxManager: inner, timings: jobTimings.create() })

            await manager.release(log)
            await manager.invalidate(log)
            await manager.shutdown(log)
            manager.getActiveSandbox()

            expect(inner.release).toHaveBeenCalledWith(log)
            expect(inner.invalidate).toHaveBeenCalledWith(log)
            expect(inner.shutdown).toHaveBeenCalledWith(log)
            expect(inner.getActiveSandbox).toHaveBeenCalled()
        })
    })
})
