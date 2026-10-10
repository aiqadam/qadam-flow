import { agentToolPins, apVersionUtil } from '@aiqadam/server-utils'
import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    isNil,
    NPM_PACKAGE_NAME_REGEX,
    qadamVersionParser,
    Step,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { qadamMetadataService } from './qadam-metadata-service'
import { isNewerVersion } from './utils'

export const MALFORMED_TOOL_PIN = 'malformed pin'
// npm's own limit on a package name.
const NPM_PACKAGE_NAME_MAX_LENGTH = 214

// A step keeps the exact qadam version it was configured with, and three call sites each needed
// their own copy of "walk the steps, find the pinned ones, ask qadamMetadataService whether the
// pin still resolves": `ap-validate-flow.ts`'s pre-publish check, `migrate-v19`'s wildcard strip,
// and the throwing prop-validator in `flow-version-validator-util.ts`. This collects the
// steps/pins/resolution shape the first two share; `getOrThrow` in the validator needs the
// resolved piece's `actions`/`triggers`/`auth` for prop validation, not just a resolvability
// answer, so it is left calling `qadamMetadataService` directly (#474).
//
// What the worker provisions is every PIECE step and every PIECE tool of an agent step
// (`extractQadamPackages`), so a report of what would fail provisioning has to cover both:
// `getQadamSteps` is the steps, `getAgentToolPins` the tools (#779).
export const qadamPinUtil = {
    getQadamSteps({ trigger }: { trigger: Step }): QadamPinnedStep[] {
        return flowStructureUtil.getAllSteps(trigger)
            .filter((step): step is QadamPinnedStep =>
                (step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE)
                && !isNil(step.settings.qadamName)
                && !isNil(step.settings.qadamVersion))
    },

    // The PIECE tools of every agent step, each with the step that holds it. Tools are not steps:
    // nothing here may rewrite one (the heal migration reads `getQadamSteps` only).
    getAgentToolPins({ trigger }: { trigger: Step }): AgentToolPinOfStep[] {
        return flowStructureUtil.getAllSteps(trigger).flatMap((step) => qadamPinUtil.getAgentToolPinsOfStep({ step }))
    },

    getAgentToolPinsOfStep({ step }: { step: Step }): AgentToolPinOfStep[] {
        if (step.type !== FlowActionType.PIECE) {
            return []
        }
        return agentToolPins.fromInput({ input: step.settings.input }).map((tool) => ({
            ...tool,
            stepName: step.name,
            stepDisplayName: step.displayName,
        }))
    },

    pinOf({ step }: { step: QadamPinnedStep }): string {
        return `${step.settings.qadamName}@${step.settings.qadamVersion}`
    },

    // A tool's name and version are not validated when stored. A well-formed pair is `name@version`,
    // which cannot be confused with another well-formed pair (a name has no `@` past its scope, a
    // version none at all). A pair that is not well-formed is the one constant key MALFORMED_TOOL_PIN:
    // the lookup answers it as a miss, and it can neither collide with a valid pin (a tool named ''
    // with version 'scope/foo@1.0.0' would read as `@scope/foo@1.0.0`) nor carry free text into a
    // message (#779).
    pinOfTool({ tool }: { tool: AgentToolPinOfStep }): string {
        const isWellFormed = tool.qadamName.length <= NPM_PACKAGE_NAME_MAX_LENGTH
            && NPM_PACKAGE_NAME_REGEX.test(tool.qadamName)
            && qadamVersionParser.parsePin({ pin: tool.qadamVersion }) !== null
        return isWellFormed ? `${tool.qadamName}@${tool.qadamVersion}` : MALFORMED_TOOL_PIN
    },

    // Scoped names carry their own `@`, so the pin is split on the LAST `@` rather than the first.
    // Every caller today feeds this `pinOf`'s own output, which always contains one, but this is an
    // exported util — a pin with no `@` at all must not silently drop its last character into
    // `name` (`lastIndexOf` returning `-1` would otherwise do exactly that via `slice(0, -1)`).
    splitPin({ pin }: { pin: string }): { name: string, version: string } {
        const separator = pin.lastIndexOf('@')
        if (separator === -1) {
            return { name: pin, version: '' }
        }
        return { name: pin.slice(0, separator), version: pin.slice(separator + 1) }
    },

    // Distinct (name, version) pairs only: a flow with twelve steps on one pin should cost one
    // resolution, not twelve, and the answer cannot differ between them.
    collectDistinctPins({ steps, tools = [] }: { steps: QadamPinnedStep[], tools?: AgentToolPinOfStep[] }): string[] {
        // A Set of strings, not `unique`: that compares entries with `findIndex` and a stringify per
        // entry, which is quadratic, and a member can save one agent step with a hundred thousand tools.
        return [...new Set([
            ...steps.map(step => qadamPinUtil.pinOf({ step })),
            ...tools.map(tool => qadamPinUtil.pinOfTool({ tool })),
        ])]
    },

    // The raw, throwing primitive: mirrors `qadamMetadataService.get()` itself — a miss returns
    // `undefined`, a real failure (DB down, disk read) propagates. A caller that must degrade
    // instead of failing (a live MCP tool, the heal migration) wraps this in `tryCatch`; a caller
    // that already accepts a migration-wide throw (the wildcard-stripping migration, which never
    // wrapped its own `get()` call either) can call it exactly as it called `get()` before.
    async resolvePinVersion({ name, version, platformId, log }: {
        name: string
        version: string
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<string | undefined> {
        const metadata = await qadamMetadataService(log).get({ platformId, name, version })
        return metadata?.version
    },

    // Tri-state, deliberately: `true` is resolved, `false` is a definite miss (the lookup
    // completed and found nothing), `undefined` is "the lookup errored" — a statement timeout,
    // pool exhaustion, a failover, an `ECONNRESET`. Collapsing the last two into one `false` is
    // safe for the two read-only reporting callers (`ap_validate_flow`, `ap_flow_structure`
    // already treat "anything but `true`" as "flag it", so a report reads an error the same as a
    // miss, which is the right default for a human/agent-facing report). It is NOT safe for the
    // heal migration, which uses a `false` to *persist a rewrite* — a transient error must never
    // read as "definitely dead" there, or a healthy LOCKED flow gets its pin silently changed
    // during exactly the DB-pressure window (an image upgrade) this migration is most likely to
    // run in. Callers that must not conflate the two check `=== false` explicitly.
    async resolvePins({ pins, platformId, log }: {
        pins: string[]
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<Map<string, boolean | undefined>> {
        return new Map(await Promise.all(pins.map(async (pin): Promise<[string, boolean | undefined]> => {
            const { name, version } = qadamPinUtil.splitPin({ pin })
            // An agent tool's version is not validated when it is stored, so it can be no version at
            // all ('latest'): a definite miss, not a failed lookup, and not something to ask the
            // resolver (it throws on it).
            if (qadamVersionParser.parsePin({ pin: version }) === null) {
                return [pin, false]
            }
            const { data: resolvedVersion, error } = await tryCatch(() => qadamPinUtil.resolvePinVersion({ name, version, platformId, log }))
            if (!isNil(error)) {
                return [pin, undefined]
            }
            return [pin, !isNil(resolvedVersion)]
        })))
    },

    // Heal path only: given a qadam name whose pinned version no longer resolves, find a version
    // of that same qadam the registry can currently serve — mirrors what `migrate-v30`'s
    // `findPublishedAiQadamVersion` does for one hardcoded name, generalized to any name. A
    // registry failure degrades to "no replacement found" rather than throwing.
    //
    // Picks the single HIGHEST version among the candidates, not the first match: `registry()`
    // (unlike `list()`) never runs its result through `lastVersionOfEachQadam` — it returns every
    // matching row `filterRegistry` lets through, undeduped and in whatever order
    // `fetchRegistryFromDB`'s `ORDER BY`-less `SELECT` happens to hand back (in practice, insertion
    // order — the oldest first). That was invisible for the one bundled name v30 hardcoded, because
    // a bundled qadam only ever has one registry row. A CUSTOM platform qadam accumulates one row
    // per installed version, so an unsorted `.find()` could silently downgrade a step to an older
    // release the moment its previously-pinned version is deleted. "Highest available" is the same
    // direction every hand-written `migrate-v24`..`migrate-v30` file already moves a dead pin — this
    // generalizes that convention rather than picking the version nearest the dead pin, which would
    // need its own justification for stopping short of the latest available fix.
    async findResolvableVersion({ name, platformId, log }: {
        name: string
        platformId: string | undefined
        log: FastifyBaseLogger
    }): Promise<string | undefined> {
        const { data: registry } = await tryCatch(() => qadamMetadataService(log).registry({
            release: apVersionUtil.getCurrentRelease(),
            platformId,
        }))
        const candidates = (registry ?? []).filter(entry => entry.name === name)
        return candidates.reduce<string | undefined>(
            (best, entry) => (isNil(best) || isNewerVersion(entry.version, best) ? entry.version : best),
            undefined,
        )
    },
}

export type AgentToolPinOfStep = {
    toolName: string
    qadamName: string
    qadamVersion: string
    stepName: string
    stepDisplayName: string
}

export type QadamPinnedStep = Extract<Step, { settings: { qadamName: string, qadamVersion: string } }>
