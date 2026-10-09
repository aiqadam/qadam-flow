import { ContextVersion, FrameworkContextVersion, LATEST_CONTEXT_VERSION } from '@aiqadam/qadams-framework'
import { FlowStatus } from '@aiqadam/shared'
import { frameworkCensusDoctorReport } from '../../../../src/app/qadams/census/framework-census-doctor-report'
import { FrameworkCensusStep, FrameworkCensusSummary, InstanceFrameworkCensus } from '../../../../src/app/qadams/census/framework-census-service'

// #838: the doctor must not give a false all-clear. A flow version whose step tree it could not
// read may hold steps that stop running (ADR-0002: unknown counts as still needing the old
// contract), so it fails `--fail-on-findings` and is named in the summary.
describe('frameworkCensusDoctorReport (#838)', () => {
    describe('exitCode', () => {
        it('exits 0 on a clean census, with or without --fail-on-findings', () => {
            const census = instanceCensus({})
            expect(frameworkCensusDoctorReport.exitCode({ census, failOnFindings: true })).toBe(0)
            expect(frameworkCensusDoctorReport.exitCode({ census, failOnFindings: false })).toBe(0)
        })

        it('exits 1 under --fail-on-findings when a step stops running', () => {
            const census = instanceCensus({ summary: { unsupported: 1, flowsWithUnsupportedSteps: 1 } })
            expect(frameworkCensusDoctorReport.exitCode({ census, failOnFindings: true })).toBe(1)
        })

        it('exits 1 under --fail-on-findings when a flow version could not be read, even with nothing unsupported', () => {
            const census = instanceCensus({ unreadableVersions: 2 })
            expect(frameworkCensusDoctorReport.exitCode({ census, failOnFindings: true })).toBe(1)
        })

        it('only reports without --fail-on-findings', () => {
            const census = instanceCensus({ summary: { unsupported: 1, flowsWithUnsupportedSteps: 1 }, unreadableVersions: 2 })
            expect(frameworkCensusDoctorReport.exitCode({ census, failOnFindings: false })).toBe(0)
        })
    })

    describe('lines', () => {
        it('says nothing stops running only when every flow version was read', () => {
            const lines = frameworkCensusDoctorReport.lines({ census: instanceCensus({}), retiredContextVersions: [] })
            expect(lines.at(-1)).toBe('Summary: no step stops running on this release.')
        })

        it('does not call an instance with unreadable flow versions all-clear', () => {
            const lines = frameworkCensusDoctorReport.lines({ census: instanceCensus({ unreadableVersions: 2 }), retiredContextVersions: [] })
            const summary = lines.at(-1)
            expect(summary).not.toBe('Summary: no step stops running on this release.')
            expect(summary).toContain('2 flow version(s) could not be read')
            expect(lines).toContain('  Flow versions that could not be read (their steps are in no count and may stop running): 2')
            // Per platform too: no all-clear while a version could not be read.
            expect(lines).not.toContain('  Nothing stops running on this release.')
            expect(lines).toContain('  No step the census could read stops running on this release; the unreadable flow versions above may hold some.')
        })

        it('lists the unsupported steps of each platform and names the unreadable versions in the summary', () => {
            const census = instanceCensus({
                summary: { unsupported: 1, flowsWithUnsupportedSteps: 1 },
                unreadableVersions: 1,
                steps: [step({ status: 'unsupported', contextVersion: ContextVersion.V1 }), step({ status: 'legacy', contextVersion: null })],
            })

            const lines = frameworkCensusDoctorReport.lines({ census, retiredContextVersions: [ContextVersion.V1] })

            expect(lines).toContain('Retired context versions: 1')
            expect(lines).toContain('    - project "Project" | flow "Flow" (published, ENABLED) | step "trigger" (Trigger) | census-v1-custom@1.0.0 (custom, context version 1)')
            expect(lines.filter((line) => line.startsWith('    - '))).toHaveLength(1)
            expect(lines.at(-1)).toContain('1 step occurrence(s) across 1 flow(s) stop running on this release.')
            expect(lines.at(-1)).toContain('1 flow version(s) could not be read')
        })

        it('names a pin that does not resolve and an unknown context version on the step line', () => {
            const census = instanceCensus({
                summary: { unsupported: 1, flowsWithUnsupportedSteps: 1 },
                steps: [{ ...step({ status: 'unsupported', contextVersion: null }), source: 'unresolved', pin: 'census-missing@1.0.0' }],
            })

            const lines = frameworkCensusDoctorReport.lines({ census, retiredContextVersions: [ContextVersion.V1] })

            expect(lines).toContain('    - project "Project" | flow "Flow" (published, ENABLED) | step "trigger" (Trigger) | census-missing@1.0.0 (pin does not resolve, context version unknown)')
            expect(lines).not.toContain('  Nothing stops running on this release.')
        })
    })
})

function instanceCensus({ summary = {}, unreadableVersions = 0, steps = [] }: {
    summary?: Partial<FrameworkCensusSummary>
    unreadableVersions?: number
    steps?: FrameworkCensusStep[]
}): InstanceFrameworkCensus {
    const fullSummary = { current: 0, legacy: 0, unsupported: 0, flowsWithUnsupportedSteps: 0, ...summary }
    return {
        engine: { frameworkMajor: 0, contextVersions: [LATEST_CONTEXT_VERSION] },
        summary: fullSummary,
        unreadableVersions,
        platforms: [{
            platformId: 'platform-1',
            platformName: 'Platform',
            summary: fullSummary,
            unreadableVersions,
            totalSteps: steps.length,
            steps,
        }],
    }
}

function step({ status, contextVersion }: { status: FrameworkCensusStep['status'], contextVersion: FrameworkContextVersion | null }): FrameworkCensusStep {
    return {
        projectId: 'project-1',
        projectDisplayName: 'Project',
        flowId: 'flow-1',
        flowDisplayName: 'Flow',
        flowStatus: FlowStatus.ENABLED,
        flowVersionId: 'flow-version-1',
        version: 'published',
        stepName: 'trigger',
        stepDisplayName: 'Trigger',
        pin: 'census-v1-custom@1.0.0',
        source: 'custom',
        frameworkMajor: null,
        contextVersion,
        status,
    }
}
