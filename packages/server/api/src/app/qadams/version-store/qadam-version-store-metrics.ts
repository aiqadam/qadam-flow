import { metrics } from '@opentelemetry/api'

// ADR-0004 "Store growth": the store's total size, always reported as a metric regardless of
// whether it is over the operator-warning threshold (`qadam-version-store-gc.ts` logs that warning
// separately). An observable gauge, not a counter: GC runs once a day, so the value is the last run's
// total until the next one, which is what an operator reading it between runs should see.
export const qadamVersionStoreMetrics = {
    recordSize: ({ bytes }: { bytes: number }): void => {
        registerMetrics()
        lastKnownBytes = bytes
    },
}

let metricsRegistered = false
let lastKnownBytes = 0

function registerMetrics(): void {
    if (metricsRegistered) {
        return
    }
    metricsRegistered = true
    const meter = metrics.getMeter('qadam-version-store-gc')
    meter.createObservableGauge('qadam_flow.qadam_version_store.bytes', {
        description: 'Total size of the qadam version store on disk, as of the last GC run',
        unit: 'By',
    }).addCallback((result) => result.observe(lastKnownBytes))
}
