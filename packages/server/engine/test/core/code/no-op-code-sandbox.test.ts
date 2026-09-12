import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { noOpCodeSandbox } from '../../../src/lib/core/code/no-op-code-sandbox'

const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'no-op-code-sandbox-'))

function writeFixture({ name, source }: { name: string, source: string }): string {
    const dir = path.join(fixtureRoot, name)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'index.js')
    writeFileSync(file, source, 'utf8')
    return file
}

const reportPid = writeFixture({
    name: 'report_pid',
    source: 'module.exports = { code: async () => ({ pid: process.pid }) }',
})

const countCalls = writeFixture({
    name: 'count_calls',
    source: 'let calls = 0\nmodule.exports = { code: async () => ({ calls: ++calls }) }',
})

const crashAsync = writeFixture({
    name: 'crash_async',
    source: 'module.exports = { code: async () => new Promise(() => { setTimeout(() => { throw new Error("async boom") }, 5) }) }',
})

const exitProcess = writeFixture({
    name: 'exit_process',
    source: 'module.exports = { code: async () => { process.exit(3) } }',
})

// Succeeds, but leaves a timer that throws well after the reply has been sent.
const strayThrowLater = writeFixture({
    name: 'stray_throw_later',
    source: 'module.exports = { code: async () => { setTimeout(() => { throw new Error("STRAY FROM EARLIER STEP") }, 25); return { pid: process.pid } } }',
})

// Succeeds, but leaves a timer that writes to stdout after the reply has been sent.
const strayLogLater = writeFixture({
    name: 'stray_log_later',
    source: 'module.exports = { code: async () => { setTimeout(() => console.log("STDOUT FROM EARLIER STEP"), 25); return { ok: true } } }',
})

// An unref'd timer keeps nothing alive, so `process.getActiveResourcesInfo()` cannot see
// it — but the IPC channel keeps the loop running, so it still fires. `.unref()` is
// idiomatic inside npm client libraries, so this reaches flows nobody wrote it in.
const strayUnrefThrowLater = writeFixture({
    name: 'stray_unref_throw_later',
    source: 'module.exports = { code: async () => { const t = setTimeout(() => { throw new Error("UNREF STRAY FROM EARLIER STEP") }, 25); t.unref(); return { pid: process.pid } } }',
})

// A step that logs heavily, and one that opens a handle and closes it properly, are both
// clean: they must keep the reuse that makes this change worth having.
const heavyLogger = writeFixture({
    name: 'heavy_logger',
    source: 'module.exports = { code: async () => { for (let i = 0; i < 2000; i++) console.log("x".repeat(200) + " " + i); return { pid: process.pid } } }',
})

const opensAndClosesServer = writeFixture({
    name: 'opens_and_closes_server',
    source: 'module.exports = { code: async () => { const s = require("net").createServer(); await new Promise(r => s.listen(0, r)); await new Promise(r => s.close(r)); return { pid: process.pid } } }',
})

const slowThenFail = writeFixture({
    name: 'slow_then_fail',
    source: 'module.exports = { code: async () => { await new Promise(r => setTimeout(r, 200)); throw new Error("own failure") } }',
})

const slowAndClean = writeFixture({
    name: 'slow_and_clean',
    source: 'module.exports = { code: async () => { await new Promise(r => setTimeout(r, 200)); return { clean: true } } }',
})

// Forges the reply the runner uses to announce it is finished, then stays alive.
const forgeTerminal = writeFixture({
    name: 'forge_terminal',
    source: 'module.exports = { code: async () => { console.log("PID=" + process.pid); process.send({ id: 0, success: true, terminal: true }); setInterval(() => {}, 50); return { pid: process.pid } } }',
})

function readPid(value: unknown): number {
    if (typeof value === 'object' && value !== null && 'pid' in value && typeof value.pid === 'number') {
        return value.pid
    }
    return Number.NaN
}

async function runPid(codeFilePath: string = reportPid): Promise<number> {
    return readPid(await noOpCodeSandbox.runCodeModule({ codeFilePath, inputs: {} }))
}

// `process.kill(pid, 0)` succeeds for an exited-but-not-yet-reaped child, so a bare check
// reports a zombie as alive. Polling separates "still executing" — which is the defect
// these tests exist to catch, and which would never clear — from "reaped a tick later".
async function waitUntilGone(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            process.kill(pid, 0)
        }
        catch {
            return true
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
}

describe('noOpCodeSandbox', () => {
    afterEach(async () => {
        await noOpCodeSandbox.shutdown()
    })

    it('should serve consecutive executions from one runner process', async () => {
        const [first, second, third] = [await runPid(), await runPid(), await runPid()]

        expect(first).toBe(second)
        expect(second).toBe(third)
    })

    it('should start a fresh runner after shutdown, so a runner never outlives its job', async () => {
        const duringFirstJob = await runPid()
        await noOpCodeSandbox.shutdown()
        const duringSecondJob = await runPid()

        expect(duringSecondJob).not.toBe(duringFirstJob)
    })

    it('should leave no live runner process behind after shutdown', async () => {
        const pid = await runPid()
        await noOpCodeSandbox.shutdown()

        expect(await waitUntilGone(pid)).toBe(true)
    })

    it('should give every execution a fresh module graph despite reusing the process', async () => {
        const first = await noOpCodeSandbox.runCodeModule({ codeFilePath: countCalls, inputs: {} })
        const second = await noOpCodeSandbox.runCodeModule({ codeFilePath: countCalls, inputs: {} })

        expect(first).toEqual({ calls: 1 })
        expect(second).toEqual({ calls: 1 })
    })

    it('should fail only the crashing execution and serve the next one from a new runner', async () => {
        const before = await runPid()

        await expect(noOpCodeSandbox.runCodeModule({ codeFilePath: crashAsync, inputs: {} }))
            .rejects.toThrow('async boom')

        const after = await runPid()
        expect(after).not.toBe(before)
    })

    it('should survive user code calling process.exit and keep serving later executions', async () => {
        const before = await runPid()

        await expect(noOpCodeSandbox.runCodeModule({ codeFilePath: exitProcess, inputs: {} }))
            .rejects.toThrow('exited with code 3')

        const after = await runPid()
        expect(after).not.toBe(before)
    })

    it('should not let a timer left by an earlier execution fail a later one', async () => {
        const leakyPid = await runPid(strayThrowLater)
        const next = await noOpCodeSandbox.runCodeModule({ codeFilePath: slowAndClean, inputs: {} })

        expect(next).toEqual({ clean: true })
        expect(await runPid()).not.toBe(leakyPid)
    })

    it('should not let an unref\'d timer left by an earlier execution fail a later one', async () => {
        const leakyPid = await runPid(strayUnrefThrowLater)
        const next = await noOpCodeSandbox.runCodeModule({ codeFilePath: slowAndClean, inputs: {} })

        expect(next).toEqual({ clean: true })
        expect(await runPid()).not.toBe(leakyPid)
    })

    it('should keep reusing the runner for a step that only logs heavily', async () => {
        const first = await runPid(heavyLogger)
        const second = await runPid(heavyLogger)

        // `Object.is(NaN, NaN)` is true, so without this guard both sides going NaN —
        // which is what `readPid` returns for a mis-shaped result — would pass silently.
        expect(Number.isInteger(first)).toBe(true)
        expect(second).toBe(first)
    })

    it('should keep reusing the runner for a step that closes its handles properly', async () => {
        const first = await runPid(opensAndClosesServer)
        const second = await runPid(opensAndClosesServer)

        expect(Number.isInteger(first)).toBe(true)
        expect(second).toBe(first)
    })

    it('should not let stdout from an earlier execution leak into a later failure message', async () => {
        await noOpCodeSandbox.runCodeModule({ codeFilePath: strayLogLater, inputs: {} })

        const error = await noOpCodeSandbox.runCodeModule({ codeFilePath: slowThenFail, inputs: {} })
            .then(() => null, (reason: Error) => reason)

        expect(error?.message).toContain('own failure')
        expect(error?.message).not.toContain('STDOUT FROM EARLIER STEP')
    })

    it('should not let user code forge a terminal reply and orphan a live runner', async () => {
        // Whether the forging step itself succeeds or fails is a race between its forged
        // reply and its real one, so that is deliberately not asserted. The property that
        // has to hold either way is that no live runner is left behind.
        const outcome = await noOpCodeSandbox.runCodeModule({ codeFilePath: forgeTerminal, inputs: {} })
            .then((value) => value, (error: Error) => error)

        const forgedPid = outcome instanceof Error
            ? Number(/PID=(\d+)/.exec(outcome.message)?.[1])
            : readPid(outcome)
        expect(Number.isInteger(forgedPid)).toBe(true)

        await noOpCodeSandbox.shutdown()
        expect(await waitUntilGone(forgedPid)).toBe(true)
    })

    it('should tolerate shutdown when no execution has ever run', async () => {
        await expect(noOpCodeSandbox.shutdown()).resolves.toBeUndefined()
    })
})
