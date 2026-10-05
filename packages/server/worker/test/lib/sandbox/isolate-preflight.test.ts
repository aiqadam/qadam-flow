import { ExecutionMode } from '@aiqadam/shared'
import type { Logger } from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnWithKillMock } = vi.hoisted(() => ({
    spawnWithKillMock: vi.fn(),
}))

vi.mock('../../../src/lib/utils/exec', () => ({
    spawnWithKill: spawnWithKillMock,
    execPromise: vi.fn(),
}))

import { IsolatePreflightError, isolatePreflight } from '../../../src/lib/sandbox/isolate-preflight'

function createMockLogger(): Logger {
    return {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
    } as unknown as Logger
}

describe('isolatePreflight.assertRunnable', () => {
    beforeEach(() => {
        spawnWithKillMock.mockReset()
        spawnWithKillMock.mockResolvedValue({ stdout: '', stderr: '' })
    })

    it.each([
        ExecutionMode.UNSANDBOXED,
        ExecutionMode.SANDBOX_CODE_ONLY,
    ])('does not probe fork mode %s', async (executionMode) => {
        const log = createMockLogger()

        await isolatePreflight.assertRunnable({ executionMode, log })

        expect(spawnWithKillMock).not.toHaveBeenCalled()
        expect(log.info).not.toHaveBeenCalled()
    })

    it.each([
        ExecutionMode.SANDBOX_PROCESS,
        ExecutionMode.SANDBOX_CODE_AND_PROCESS,
    ])('probes isolate mode %s with --cleanup, --init, --run and a final --cleanup', async (executionMode) => {
        const log = createMockLogger()

        await isolatePreflight.assertRunnable({ executionMode, log })

        const calls = spawnWithKillMock.mock.calls.map(([params]) => (params as { args: string[] }).args)
        expect(calls).toHaveLength(4)
        expect(calls[0]).toEqual(['--box-id=0', '--cleanup'])
        expect(calls[1]).toEqual(['--box-id=0', '--init'])
        expect(calls[2]).toEqual(['--box-id=0', '--run', '--', '/bin/true'])
        expect(calls[3]).toEqual(['--box-id=0', '--cleanup'])
        expect(log.info).toHaveBeenCalledWith({ executionMode }, 'Isolate execution mode preflight passed')
    })

    it('fails with an actionable message when the isolate probe cannot create a box', async () => {
        spawnWithKillMock
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockResolvedValueOnce({ stdout: '', stderr: '' })
            .mockRejectedValueOnce(new Error('Cannot run proxy, clone failed: Operation not permitted'))
            .mockResolvedValueOnce({ stdout: '', stderr: '' })

        const error = await isolatePreflight
            .assertRunnable({ executionMode: ExecutionMode.SANDBOX_PROCESS, log: createMockLogger() })
            .then(() => null)
            .catch((err: unknown) => err)

        expect(error).toBeInstanceOf(IsolatePreflightError)
        const message = (error as Error).message
        expect(message).toContain('AP_EXECUTION_MODE=SANDBOX_PROCESS')
        expect(message).toContain('CAP_SYS_ADMIN')
        expect(message).toContain('docker-compose.sandboxed.yml')
        expect(message).toContain('Operation not permitted')
        // The final cleanup still runs so a failed probe does not leave box 0 initialised behind.
        expect(spawnWithKillMock).toHaveBeenCalledTimes(4)
    })

    it('lets a caller override the probe (so the mode gate can be tested without isolate)', async () => {
        const runProbe = vi.fn().mockResolvedValue(undefined)

        await isolatePreflight.assertRunnable({
            executionMode: ExecutionMode.SANDBOX_CODE_AND_PROCESS,
            log: createMockLogger(),
            runProbe,
        })

        expect(runProbe).toHaveBeenCalledTimes(1)
        expect(spawnWithKillMock).not.toHaveBeenCalled()
    })
})
