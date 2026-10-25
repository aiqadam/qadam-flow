import { qadamSignatureLedger, QadamVersionFetchOutcome, qadamVersionStoreFetch } from '@aiqadam/server-utils'
import { ApEnvironment, chunk, flowQadamUtil, isNil, isOfficialQadamName, PlatformId, qadamVersionParser, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { qadamMetadataService } from '../metadata/qadam-metadata-service'
import { QadamPinnedStep, qadamPinUtil } from '../metadata/qadam-pin-util'
import { qadamVersionStoreAccess } from '../version-store/qadam-version-store-access'

// ADR-0003 "Fetching", the publish/import/start-up half: given the pins a flow (or, at start-up,
// many flows) names, fetch into the store exactly the ones that are official, an exact release, and
// not already available anywhere this instance already looks (the registry rows, the bundled image,
// or the store itself). A pin this leaves alone is not a failure — it is left for the existing
// unavailable-version fallback (#808) to decide, the same as before this module existed.
//
// Never asked of the network, by design (ADR-0005, and the maintainer's own scoping comment on
// #806): a range pin (`^`/`~` — it resolves against what the instance already holds, never the
// newest the registry has), a `-main.` snapshot pin (moved only by the checked fallback, #808/
// ADR-0004), and a custom (non-`@aiqadam/`) pin (#478's registry is not built yet).
//
// Short-circuits in the TESTING environment the same way `flowTriggerSideEffect` does for its own
// external call: there is no registry to fetch from in an integration test, and the module-level
// `environment` read (not a per-call check) is what lets a unit test exercise the real logic, by
// mocking `system.getOrThrow` to answer `PRODUCTION` instead (see `flow-trigger-side-effect.test.ts`
// for the pattern this follows).
const environment = system.getOrThrow<ApEnvironment>(AppSystemProp.ENVIRONMENT)

export const qadamVersionFetch = (log: FastifyBaseLogger): QadamVersionFetch => ({
    // The publish/import entry point: the distinct pins among `steps`' qadams.
    fetchMissingStepPins: ({ steps, platformId }: FetchMissingStepPinsParams): Promise<QadamVersionFetchSummary> => {
        return fetchMissing({ pins: qadamPinUtil.collectDistinctPins({ steps }), platformId, log })
    },

    // The start-up entry point: an already-collected, already-deduplicated list of `name@version`
    // pins, from however many flows a caller walked.
    fetchMissingPins: ({ pins, platformId }: FetchMissingPinsParams): Promise<QadamVersionFetchSummary> => {
        return fetchMissing({ pins, platformId, log })
    },
})

// A flow rarely pins more than a handful of distinct qadams, but the start-up pass can collect many
// across a whole platform; bounded so a cold start does not open hundreds of connections to the
// registry at once.
const FETCH_CONCURRENCY = 4

const EMPTY_SUMMARY: QadamVersionFetchSummary = { attempted: 0, fetched: 0, failed: 0 }

async function fetchMissing({ pins, platformId, log }: FetchMissingPinsParams & { log: FastifyBaseLogger }): Promise<QadamVersionFetchSummary> {
    if (environment === ApEnvironment.TESTING) {
        return EMPTY_SUMMARY
    }
    const candidates = collectCandidates({ pins })
    if (candidates.length === 0) {
        return EMPTY_SUMMARY
    }
    const opened = await qadamVersionStoreAccess.open({ log })
    if (!opened.ok) {
        log.warn({ reason: opened.reason }, '[qadamVersionFetch] the qadam version store is unavailable; missing pins are left for the existing fallback')
        return EMPTY_SUMMARY
    }
    const missing = await filterMissing({ candidates, platformId, log })
    if (missing.length === 0) {
        return EMPTY_SUMMARY
    }
    const ledger = qadamSignatureLedger.open({ dir: opened.store.root, log })
    const outcomes: FetchOutcome[] = []
    for (const batch of chunk(missing, FETCH_CONCURRENCY)) {
        const batchResults = await Promise.all(batch.map(async (candidate): Promise<FetchOutcome> => ({
            candidate,
            result: await qadamVersionStoreFetch.fetchFromRegistry({ store: opened.store, ledger, name: candidate.name, version: candidate.version, log }),
        })))
        outcomes.push(...batchResults)
    }
    return summarize({ outcomes, log })
}

function collectCandidates({ pins }: { pins: string[] }): QadamFetchCandidate[] {
    const byKey = new Map<string, QadamFetchCandidate>()
    for (const pin of pins) {
        const { name, version: rawVersion } = qadamPinUtil.splitPin({ pin })
        if (!isOfficialQadamName(name)) {
            continue
        }
        const version = flowQadamUtil.getExactVersion(rawVersion)
        const parsed = qadamVersionParser.parse({ version })
        if (isNil(parsed) || parsed.snapshot !== null) {
            continue
        }
        byKey.set(`${name}@${version}`, { name, version })
    }
    return [...byKey.values()]
}

// A pin whose availability could not be checked (a transient DB error) is left alone: the same
// conservative read `qadamPinMoveService`'s own `findUnavailablePins` makes, and for the same
// reason — a blip must not turn into a registry fetch nor into "nothing to do" that masks one.
async function filterMissing({ candidates, platformId, log }: { candidates: QadamFetchCandidate[], platformId: PlatformId | undefined, log: FastifyBaseLogger }): Promise<QadamFetchCandidate[]> {
    const checks = await Promise.all(candidates.map(async (candidate) => {
        const { data: available, error } = await tryCatch(() => qadamMetadataService(log).isPinAvailable({ name: candidate.name, version: candidate.version, platformId }))
        return { candidate, missing: isNil(error) && available === false }
    }))
    return checks.filter((check) => check.missing).map((check) => check.candidate)
}

function summarize({ outcomes, log }: { outcomes: FetchOutcome[], log: FastifyBaseLogger }): QadamVersionFetchSummary {
    const fetched = outcomes.filter(({ result }) => result.outcome === QadamVersionFetchOutcome.FETCHED)
    const failed = outcomes.filter(({ result }) => result.outcome !== QadamVersionFetchOutcome.FETCHED)
    fetched.forEach(({ candidate }) => {
        log.info({ qadam: `${candidate.name}@${candidate.version}` }, '[qadamVersionFetch] fetched a missing qadam version into the store')
    })
    failed.forEach(({ candidate, result }) => {
        log.warn({ qadam: `${candidate.name}@${candidate.version}`, outcome: result.outcome, reason: 'reason' in result ? result.reason : undefined }, '[qadamVersionFetch] could not fetch a missing qadam version; it is left for the existing fallback')
    })
    return { attempted: outcomes.length, fetched: fetched.length, failed: failed.length }
}

export type QadamVersionFetch = {
    fetchMissingStepPins: (params: FetchMissingStepPinsParams) => Promise<QadamVersionFetchSummary>
    fetchMissingPins: (params: FetchMissingPinsParams) => Promise<QadamVersionFetchSummary>
}

export type QadamVersionFetchSummary = {
    attempted: number
    fetched: number
    failed: number
}

type QadamFetchCandidate = {
    name: string
    version: string
}

type FetchOutcome = {
    candidate: QadamFetchCandidate
    result: Awaited<ReturnType<typeof qadamVersionStoreFetch.fetchFromRegistry>>
}

type FetchMissingStepPinsParams = {
    steps: QadamPinnedStep[]
    platformId: PlatformId | undefined
}

type FetchMissingPinsParams = {
    pins: string[]
    platformId: PlatformId | undefined
}
