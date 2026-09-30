import { monitorEventLoopDelay } from 'node:perf_hooks'

/**
 * Warns when the event loop was blocked for longer than `thresholdMs` within a `windowMs` window,
 * and writes nothing otherwise (#587). A blocked loop stalls every request, socket and RPC the
 * process serves at once, and no per-request log can show it, because none of them runs while it
 * lasts.
 */
export const eventLoopMonitor = {
    start({
        log,
        resolutionMs = DEFAULTS.resolutionMs,
        windowMs = DEFAULTS.windowMs,
        thresholdMs = DEFAULTS.thresholdMs,
    }: StartParams): EventLoopMonitor {
        const histogram = monitorEventLoopDelay({ resolution: resolutionMs })
        histogram.enable()
        const timer = setInterval(() => {
            const window = readWindow({ histogram, resolutionMs })
            histogram.reset()
            if (window.maxLagMs >= thresholdMs) {
                log.warn({ ...window, windowMs, thresholdMs }, '[eventLoopMonitor] Event loop was blocked')
            }
        }, windowMs)
        timer.unref()
        return {
            stop(): void {
                clearInterval(timer)
                histogram.disable()
            },
        }
    },
}

const DEFAULTS = {
    resolutionMs: 20,
    windowMs: 10_000,
    thresholdMs: 500,
}

// The histogram records the whole interval between samples, so an idle loop reads as the
// resolution itself; the lag is what exceeds it.
function readWindow({ histogram, resolutionMs }: ReadWindowParams): LagWindow {
    // An empty window reads NaN for the mean, which is no lag, not an unknown one.
    const toLagMs = (ns: number): number => Number.isFinite(ns) ? Math.max(0, Math.round(ns / 1e6 - resolutionMs)) : 0
    return {
        maxLagMs: toLagMs(histogram.max),
        p99LagMs: toLagMs(histogram.percentile(99)),
        meanLagMs: toLagMs(histogram.mean),
    }
}

export type EventLoopMonitor = {
    stop(): void
}

type EventLoopMonitorLogger = {
    warn: (obj: Record<string, unknown>, msg: string) => void
}

type StartParams = {
    log: EventLoopMonitorLogger
    resolutionMs?: number
    windowMs?: number
    thresholdMs?: number
}

type ReadWindowParams = {
    histogram: { max: number, mean: number, percentile(p: number): number }
    resolutionMs: number
}

type LagWindow = {
    maxLagMs: number
    p99LagMs: number
    meanLagMs: number
}
