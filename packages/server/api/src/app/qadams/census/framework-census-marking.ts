import { FastifyBaseLogger } from 'fastify'
import { QadamPinnedStep, qadamPinUtil } from '../metadata/qadam-pin-util'
import { frameworkCensusPolicy } from './framework-census-policy'
import { frameworkCensusService, PinFrameworkSupport } from './framework-census-service'

// The per-request half of the ADR-0002 census: mark the steps a release has stopped running, in
// the surfaces an agent reads before a run (the MCP tools; builder and runs marking are not built
// yet). The expensive resolution only happens once a shim has actually been retired — every
// release until then skips it entirely (`hasRetiredContextVersion()`), so the surfaces keep their
// current cost.
export const frameworkCensusMarking = (log: FastifyBaseLogger) => ({
    // The pins whose qadam needs a retired context version, keyed by pin. Empty while every
    // context version the support table lists is still run.
    async unsupportedPins({ qadamSteps, platformId }: { qadamSteps: QadamPinnedStep[], platformId: string }): Promise<Map<string, PinFrameworkSupport>> {
        if (!frameworkCensusPolicy.hasRetiredContextVersion() || qadamSteps.length === 0) {
            return new Map()
        }
        const supportByPin = await frameworkCensusService(log).resolvePins({
            pins: qadamPinUtil.collectDistinctPins({ steps: qadamSteps }),
            platformId,
        })
        return new Map([...supportByPin].filter(([, support]) => support.status === 'unsupported'))
    },

    // One line at boot, so a retirement is visible in the operator's logs even before anyone opens
    // a surface. The step list itself is the `doctor` command's output, not a start-up walk.
    logRetirement(): void {
        const retired = frameworkCensusPolicy.retiredContextVersions()
        if (retired.length === 0) {
            return
        }
        log.warn({
            retiredContextVersions: retired,
            engineContextVersions: frameworkCensusPolicy.engineContextVersions(),
        }, '[frameworkCensus] This release no longer runs some framework context versions. Steps pinned to qadams built against them are marked "framework version no longer supported — update this step" by the MCP tools ap_flow_structure and ap_validate_flow, and listed in the banner on the platform Health page. Run the framework census (doctor) to list them all; no flow is disabled.')
    },
})

export type { PinFrameworkSupport }
