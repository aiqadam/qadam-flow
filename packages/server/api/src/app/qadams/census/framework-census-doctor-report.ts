import { FrameworkContextVersion } from '@aiqadam/qadams-framework'
import { isNil } from '@aiqadam/shared'
import { FrameworkCensusStep, InstanceFrameworkCensus } from './framework-census-service'

// What the `doctor` command (`src/scripts/framework-census-doctor.ts`) prints and how it exits,
// kept apart from the script so both can be tested without a process. A flow version whose step
// tree could not be read is a finding too: ADR-0002 counts an unknown as still needing the old
// contract, so the doctor never calls such an instance all-clear.
export const frameworkCensusDoctorReport = {
    lines({ census, retiredContextVersions }: { census: InstanceFrameworkCensus, retiredContextVersions: FrameworkContextVersion[] }): string[] {
        return [
            'Framework census (ADR-0002) — qadam-flow',
            '',
            `Engine: framework major ${census.engine.frameworkMajor}; context versions it runs: ${census.engine.contextVersions.join(', ')}`,
            `Retired context versions: ${retiredContextVersions.join(', ') || '(none — nothing can stop running on this release)'}`,
            '',
            ...census.platforms.flatMap((platform) => platformLines({ platform })),
            summaryLine({ census }),
        ]
    },

    // `--fail-on-findings` makes the doctor an automated gate: a step that stops running fails it,
    // and so does a flow version it could not read, whose steps may stop running too.
    exitCode({ census, failOnFindings }: { census: InstanceFrameworkCensus, failOnFindings: boolean }): number {
        return failOnFindings && hasFindings({ census }) ? 1 : 0
    },
}

function hasFindings({ census }: { census: InstanceFrameworkCensus }): boolean {
    return census.summary.unsupported > 0 || census.unreadableVersions > 0
}

function platformLines({ platform }: { platform: InstanceFrameworkCensus['platforms'][number] }): string[] {
    const unsupported = platform.steps.filter((step) => step.status === 'unsupported')
    return [
        `Platform: ${platform.platformName}`,
        `  Steps by status: ${platform.summary.current} current, ${platform.summary.legacy} legacy, ${platform.summary.unsupported} unsupported`,
        ...(platform.unreadableVersions > 0
            ? [`  Flow versions that could not be read (their steps are in no count and may stop running): ${platform.unreadableVersions}`]
            : []),
        ...unsupportedLines({ unsupported, unreadableVersions: platform.unreadableVersions }),
        '',
    ]
}

// "Nothing stops running" only when every flow version of the platform was read: an unreadable one
// may hold steps that stop running (ADR-0002), so the all-clear is hedged then.
function unsupportedLines({ unsupported, unreadableVersions }: { unsupported: FrameworkCensusStep[], unreadableVersions: number }): string[] {
    if (unsupported.length > 0) {
        return ['  Steps that stop running on this release:', ...unsupported.map((step) => `    - ${formatStep({ step })}`)]
    }
    return unreadableVersions === 0
        ? ['  Nothing stops running on this release.']
        : ['  No step the census could read stops running on this release; the unreadable flow versions above may hold some.']
}

function summaryLine({ census }: { census: InstanceFrameworkCensus }): string {
    const { unsupported, flowsWithUnsupportedSteps } = census.summary
    const unreadable = census.unreadableVersions
    const unreadableNote = unreadable > 0
        ? ` ${unreadable} flow version(s) could not be read; their steps are in no count and may stop running too — check the log for their ids.`
        : ''
    if (unsupported === 0) {
        return unreadable === 0
            ? 'Summary: no step stops running on this release.'
            : `Summary: no step the census could read stops running on this release.${unreadableNote}`
    }
    return `Summary: ${unsupported} step occurrence(s) across ${flowsWithUnsupportedSteps} flow(s) stop running on this release. Update each step to a qadam version built against a supported framework version. No flow is disabled.${unreadableNote}`
}

function formatStep({ step }: { step: FrameworkCensusStep }): string {
    const context = isNil(step.contextVersion) ? 'context version unknown' : `context version ${step.contextVersion}`
    const source = step.source === 'unresolved' ? 'pin does not resolve' : step.source
    return `project "${step.projectDisplayName}" | flow "${step.flowDisplayName}" (${step.version}, ${step.flowStatus}) | step "${step.stepName}" (${step.stepDisplayName}) | ${step.pin} (${source}, ${context})`
}
