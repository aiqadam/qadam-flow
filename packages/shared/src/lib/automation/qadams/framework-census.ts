import { z } from 'zod'

// The framework-major census of ADR-0002 (#803), as returned to the platform admin surfaces. The
// server resolves it per platform from stored flow versions (`framework-census-service.ts`); these
// schemas are the wire contract only.

export const FrameworkCensusStatus = z.enum(['current', 'legacy', 'unsupported'])

export const FrameworkCensusPinSource = z.enum(['official', 'custom', 'unresolved'])

export const FrameworkCensusStep = z.object({
    projectId: z.string(),
    projectDisplayName: z.string(),
    flowId: z.string(),
    flowDisplayName: z.string(),
    // `FlowStatus`'s values, inlined: importing `../flows/flow` here would close the
    // flows ↔ qadams barrel cycle (`flows/actions/action.ts` imports `../../qadams`), and the enum
    // would be `undefined` while this module evaluates.
    flowStatus: z.enum(['ENABLED', 'DISABLED']),
    flowVersionId: z.string(),
    // Which of the flow's two meaningful versions the occurrence is: the published one that runs,
    // or the latest draft the builder edits and test runs use.
    version: z.enum(['published', 'draft']),
    stepName: z.string(),
    stepDisplayName: z.string(),
    pin: z.string(),
    source: FrameworkCensusPinSource,
    // Known only for a bundled official build; `null` elsewhere.
    frameworkMajor: z.number().nullable(),
    // `null` is unknown, which counts as still needing the old contract (ADR-0002).
    contextVersion: z.string().nullable(),
    status: FrameworkCensusStatus,
})

export const FrameworkCensusSummary = z.object({
    // Step occurrences: a step present in both the published and the latest version counts twice.
    current: z.number(),
    legacy: z.number(),
    unsupported: z.number(),
    flowsWithUnsupportedSteps: z.number(),
})

export const FrameworkCensusEngine = z.object({
    frameworkMajor: z.number(),
    contextVersions: z.array(z.string()),
})

export const FrameworkCensusResponse = z.object({
    engine: FrameworkCensusEngine,
    // The context versions the support table knows that this release no longer runs. Empty means
    // nothing can stop running yet.
    retiredContextVersions: z.array(z.string()),
    // `false` while `retiredContextVersions` is empty: no step can be unsupported then, so the
    // platform's flows are not walked and `summary`, `unreadableVersions` and `steps` are all
    // empty. Listing what a coming release would stop running is the `doctor` command's job.
    ran: z.boolean(),
    summary: FrameworkCensusSummary,
    // Flow versions whose step tree could not be walked; their steps are not in the counts.
    unreadableVersions: z.number(),
    // How many `legacy` and `unsupported` step occurrences the census found; `steps` may carry
    // fewer.
    totalSteps: z.number(),
    // `legacy` and `unsupported` steps only, `unsupported` first and capped (see `totalSteps`);
    // `current` ones are counted in the summary.
    steps: z.array(FrameworkCensusStep),
})

export type FrameworkCensusStatus = z.infer<typeof FrameworkCensusStatus>
export type FrameworkCensusPinSource = z.infer<typeof FrameworkCensusPinSource>
export type FrameworkCensusStep = z.infer<typeof FrameworkCensusStep>
export type FrameworkCensusSummary = z.infer<typeof FrameworkCensusSummary>
export type FrameworkCensusEngine = z.infer<typeof FrameworkCensusEngine>
export type FrameworkCensusResponse = z.infer<typeof FrameworkCensusResponse>
