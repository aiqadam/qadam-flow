import { qadamSignatureLedger, QadamVersionFetchOutcome, qadamVersionStoreFetch } from '@aiqadam/server-utils'
import { ApEnvironment, chunk, isNil, isOfficialQadamName, NPM_PACKAGE_NAME_MAX_LENGTH, NPM_PACKAGE_NAME_REGEX, PlatformId, qadamVersionParser, tryCatch } from '@aiqadam/shared'
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
// Never asked of the network, by design (ADR-0005 §2: "any caller that turns a range into a version
// takes that version from the catalogue or the store, never by asking a registry"): a range pin
// (`^`/`~`, left at the pin's own version string so `qadamVersionParser.parse` — which accepts no
// prefix — reads it as unparseable rather than as its floor), a `-main.` snapshot pin (moved only by
// the checked fallback, #808/ADR-0004), and a custom (non-`@aiqadam/`) pin (the configurable
// registry from #478 exists, but only records where a custom version would come from; custom
// fetching is not implemented here, so it is left alone).
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

// Caps registry round trips per publish/import/start-up call, independent of how many pins a flow or
// a platform names: an `IMPORT_FLOW` trigger tree is also this codebase's internal "copy a published
// flow" primitive, so an attacker (or an accidental thousand-step import) pinning thousands of
// distinct missing versions must not turn into thousands of outbound requests from one call. A pin
// past the cap is left exactly as before this module existed, for the existing fallback (#808).
const MAX_FETCHES_PER_CALL = 50
// One deadline for the WHOLE call, computed once and handed to every `fetchFromRegistry` — not a
// fresh one per candidate, which would let the candidate count alone decide how long a synchronous
// publish/import request stays open (`candidates.length / FETCH_CONCURRENCY` × that function's own
// per-call budget). A pin still unattempted when this deadline passes fails fast (each remaining
// call's own `remaining <= 0` check) and is left for the existing fallback, the same as a cap miss.
const FETCH_CALL_BUDGET_MS = 60_000

const EMPTY_SUMMARY: QadamVersionFetchSummary = { attempted: 0, fetched: 0, failed: 0 }

async function fetchMissing({ pins, platformId, log }: FetchMissingPinsParams & { log: FastifyBaseLogger }): Promise<QadamVersionFetchSummary> {
    if (environment === ApEnvironment.TESTING) {
        return EMPTY_SUMMARY
    }
    const allCandidates = collectCandidates({ pins })
    if (allCandidates.length === 0) {
        return EMPTY_SUMMARY
    }
    // Capped here, before `filterMissing`'s own `Promise.all` of DB lookups and store-reader opens —
    // one per candidate — not after it: a pathological pin count must not turn into an unbounded fan
    // of those either, only an unbounded fan of registry fetches.
    const candidates = allCandidates.slice(0, MAX_FETCHES_PER_CALL)
    if (candidates.length < allCandidates.length) {
        log.warn({ candidates: candidates.length, total: allCandidates.length }, '[qadamVersionFetch] more qadam pins are missing than one call checks; the rest are left for the existing fallback')
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
    const deadline = Date.now() + FETCH_CALL_BUDGET_MS
    const outcomes: FetchOutcome[] = []
    for (const batch of chunk(missing, FETCH_CONCURRENCY)) {
        const batchResults = await Promise.all(batch.map(async (candidate): Promise<FetchOutcome> => ({
            candidate,
            result: await qadamVersionStoreFetch.fetchFromRegistry({ store: opened.store, ledger, name: candidate.name, version: candidate.version, log, deadline }),
        })))
        outcomes.push(...batchResults)
    }
    return summarize({ outcomes, log })
}

function collectCandidates({ pins }: { pins: string[] }): QadamFetchCandidate[] {
    const byKey = new Map<string, QadamFetchCandidate>()
    for (const pin of pins) {
        const { name, version } = qadamPinUtil.splitPin({ pin })
        // A step's `qadamName` is stored as a bare string with no length or pattern check of its own
        // (`isOfficialQadamName` is only a scope-prefix test), so without this an arbitrary-length
        // `@aiqadam/<junk>` would still reach `readVersionDocument` and spend a registry round trip —
        // wasted, since `putTarball` would refuse the name anyway, but spent before that refusal.
        if (!isOfficialQadamName(name) || name.length > NPM_PACKAGE_NAME_MAX_LENGTH || !NPM_PACKAGE_NAME_REGEX.test(name)) {
            continue
        }
        // `parse` accepts no `^`/`~` prefix, so a range pin fails it here rather than being resolved
        // to its floor and fetched — ADR-0005 §2 reserves resolving a range for the catalogue/store.
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
