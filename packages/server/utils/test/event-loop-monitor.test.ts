import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventLoopMonitor, eventLoopMonitor } from '../src/event-loop-monitor'

function blockFor(ms: number): void {
    const until = Date.now() + ms
    while (Date.now() < until) {
        // deliberately synchronous: this is the stall under test
    }
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('eventLoopMonitor', () => {
    let monitor: EventLoopMonitor | undefined

    afterEach(() => {
        monitor?.stop()
        monitor = undefined
    })

    it('warns with the lag of a window in which the loop was blocked', async () => {
        const log = { warn: vi.fn() }
        monitor = eventLoopMonitor.start({ log, resolutionMs: 10, windowMs: 400, thresholdMs: 150 })

        await wait(50)
        blockFor(300)
        await wait(500)

        expect(log.warn).toHaveBeenCalled()
        const [fields, message] = log.warn.mock.calls[0]
        expect(message).toBe('[eventLoopMonitor] Event loop was blocked')
        expect(fields).toMatchObject({ windowMs: 400, thresholdMs: 150 })
        expect(fields.maxLagMs).toBeGreaterThanOrEqual(150)
        expect(fields.p99LagMs).toBeLessThanOrEqual(fields.maxLagMs)
    })

    it('writes nothing while the loop stays responsive', async () => {
        const log = { warn: vi.fn() }
        monitor = eventLoopMonitor.start({ log, resolutionMs: 10, windowMs: 100, thresholdMs: 250 })

        await wait(450)

        expect(log.warn).not.toHaveBeenCalled()
    })

    it('stops sampling once stopped', async () => {
        const log = { warn: vi.fn() }
        monitor = eventLoopMonitor.start({ log, resolutionMs: 10, windowMs: 100, thresholdMs: 50 })
        monitor.stop()

        blockFor(200)
        await wait(250)

        expect(log.warn).not.toHaveBeenCalled()
    })
})
