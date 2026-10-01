import { performance } from 'node:perf_hooks'
import { Sandbox } from '../sandbox/types'
import { SandboxManager } from './sandbox-manager'

/**
 * Per-job phase timings for the one `Job finished` line the poll loop writes (#587). A recorder,
 * like a span, rather than a returned value: the phases happen inside eight different handlers and
 * a job that throws must still report the phases it got through.
 */
export const jobTimings = {
    create(): JobTimings {
        let totals: PhaseTotals = {}
        let sandbox: SandboxTemperature | undefined
        return {
            async measure<T>({ phase, fn }: MeasureParams<T>): Promise<T> {
                const startedAt = performance.now()
                try {
                    return await fn()
                }
                finally {
                    totals = addToPhase({ totals, phase, ms: performance.now() - startedAt })
                }
            },
            recordSandbox(temperature: SandboxTemperature): void {
                // One cold start in the job is what explains its latency, whatever came after.
                sandbox = sandbox === 'cold' ? 'cold' : temperature
            },
            summary(): JobTimingsSummary {
                return {
                    flowVersionMs: roundMs(totals.flowVersion),
                    provisionMs: roundMs(totals.provision),
                    sandbox,
                    sandboxStartMs: roundMs(totals.sandboxStart),
                    executeMs: roundMs(totals.execute),
                    executeCount: totals.execute?.count,
                }
            },
        }
    },

    /**
     * Wraps the slot's manager for one job, so every handler's sandbox is timed without each of
     * them doing it. Delegates explicitly rather than spreading: the real manager's `release` calls
     * `this.invalidate`.
     */
    instrumentSandboxManager({ sandboxManager, timings }: InstrumentSandboxManagerParams): SandboxManager {
        return {
            acquire: (params) => instrumentSandbox({ sandbox: sandboxManager.acquire(params), timings }),
            prewarm: (params) => sandboxManager.prewarm(params),
            invalidate: (log) => sandboxManager.invalidate(log),
            release: (log) => sandboxManager.release(log),
            shutdown: (log) => sandboxManager.shutdown(log),
            markStale: () => sandboxManager.markStale(),
            getActiveSandbox: () => sandboxManager.getActiveSandbox(),
        }
    },
}

function instrumentSandbox({ sandbox, timings }: InstrumentSandboxParams): Sandbox {
    return {
        id: sandbox.id,
        start: async (options): Promise<void> => {
            // `start` returns at once on a live process, so readiness before the call is exactly
            // whether this job pays for a spawn.
            timings.recordSandbox(sandbox.isReady() ? 'warm' : 'cold')
            return timings.measure({ phase: 'sandboxStart', fn: () => sandbox.start(options) })
        },
        execute: (operationType, operation, options) => timings.measure({
            phase: 'execute',
            fn: () => sandbox.execute(operationType, operation, options),
        }),
        shutdown: () => sandbox.shutdown(),
        isReady: () => sandbox.isReady(),
        getPid: () => sandbox.getPid(),
        isBusy: () => sandbox.isBusy(),
    }
}

function addToPhase({ totals, phase, ms }: AddToPhaseParams): PhaseTotals {
    const previous = totals[phase]
    return {
        ...totals,
        [phase]: { ms: (previous?.ms ?? 0) + ms, count: (previous?.count ?? 0) + 1 },
    }
}

function roundMs(total: PhaseTotal | undefined): number | undefined {
    return total === undefined ? undefined : Math.round(total.ms)
}

export type JobPhase = 'flowVersion' | 'provision' | 'sandboxStart' | 'execute'

export type SandboxTemperature = 'cold' | 'warm'

export type JobTimings = {
    measure<T>(params: MeasureParams<T>): Promise<T>
    recordSandbox(temperature: SandboxTemperature): void
    summary(): JobTimingsSummary
}

export type JobTimingsSummary = {
    flowVersionMs: number | undefined
    provisionMs: number | undefined
    sandbox: SandboxTemperature | undefined
    sandboxStartMs: number | undefined
    executeMs: number | undefined
    executeCount: number | undefined
}

type MeasureParams<T> = {
    phase: JobPhase
    fn: () => Promise<T>
}

type PhaseTotal = {
    ms: number
    count: number
}

type PhaseTotals = Readonly<Partial<Record<JobPhase, PhaseTotal>>>

type InstrumentSandboxManagerParams = {
    sandboxManager: SandboxManager
    timings: JobTimings
}

type InstrumentSandboxParams = {
    sandbox: Sandbox
    timings: JobTimings
}

type AddToPhaseParams = {
    totals: PhaseTotals
    phase: JobPhase
    ms: number
}
