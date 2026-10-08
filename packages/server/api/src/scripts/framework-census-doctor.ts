/* eslint-disable no-console */
import { isNil } from '@aiqadam/shared'
import { openReadOnlyDatabaseConnection } from '../app/database/database-connection'
import { system } from '../app/helper/system/system'
import { frameworkCensusPolicy } from '../app/qadams/census/framework-census-policy'
import { frameworkCensusService, FrameworkCensusStep, InstanceFrameworkCensus } from '../app/qadams/census/framework-census-service'

// The `doctor` command of ADR-0002 (#803): run it from the new image, against the live database,
// before switching the containers over, and it lists the steps the release will stop running.
//
//   docker compose run --rm --entrypoint node app packages/server/api/dist/src/scripts/framework-census-doctor.js
//
// It never runs migrations and never writes: its connection (`openReadOnlyDatabaseConnection`)
// does not migrate on start-up, unlike the application's, and Postgres refuses every write on it.
// A database that predates `contextVersion` (#802) reads as unknown, and unknown counts as still
// needing the old contract. It does not block anything by itself — the release starts normally
// and no flow is disabled (#435). Pass `--fail-on-findings` to exit 1 when a step will stop
// running, for an operator that wants an automated gate. A database error ends the command with
// exit 1 rather than reporting a step it could not read as one that stops running.
async function main(): Promise<void> {
    const failOnFindings = process.argv.includes('--fail-on-findings')
    const dataSource = openReadOnlyDatabaseConnection()
    await dataSource.initialize()
    try {
        const census = await frameworkCensusService(system.globalLogger()).censusOfInstance()
        printCensus({ census })
        if (failOnFindings && census.summary.unsupported > 0) {
            process.exitCode = 1
        }
    }
    finally {
        await dataSource.destroy()
    }
}

function printCensus({ census }: { census: InstanceFrameworkCensus }): void {
    console.log('Framework census (ADR-0002) — qadam-flow')
    console.log('')
    console.log(`Engine: framework major ${census.engine.frameworkMajor}; context versions it runs: ${census.engine.contextVersions.join(', ')}`)
    console.log(`Retired context versions: ${frameworkCensusPolicy.retiredContextVersions().join(', ') || '(none — nothing can stop running on this release)'}`)
    console.log('')

    for (const platform of census.platforms) {
        console.log(`Platform: ${platform.platformName}`)
        console.log(`  Steps by status: ${platform.summary.current} current, ${platform.summary.legacy} legacy, ${platform.summary.unsupported} unsupported`)
        if (platform.unreadableVersions > 0) {
            console.log(`  Flow versions that could not be read (excluded from the counts): ${platform.unreadableVersions}`)
        }
        const unsupported = platform.steps.filter((step) => step.status === 'unsupported')
        if (unsupported.length === 0) {
            console.log('  Nothing stops running on this release.')
        }
        else {
            console.log('  Steps that stop running on this release:')
            for (const step of unsupported) {
                console.log(`    - ${formatStep({ step })}`)
            }
        }
        console.log('')
    }

    const { unsupported, flowsWithUnsupportedSteps } = census.summary
    if (unsupported === 0) {
        console.log('Summary: no step stops running on this release.')
    }
    else {
        console.log(`Summary: ${unsupported} step occurrence(s) across ${flowsWithUnsupportedSteps} flow(s) stop running on this release. Update each step to a qadam version built against a supported framework version. No flow is disabled.`)
    }
}

function formatStep({ step }: { step: FrameworkCensusStep }): string {
    const context = isNil(step.contextVersion) ? 'context version unknown' : `context version ${step.contextVersion}`
    const source = step.source === 'unresolved' ? 'pin does not resolve' : step.source
    return `project "${step.projectDisplayName}" | flow "${step.flowDisplayName}" (${step.version}, ${step.flowStatus}) | step "${step.stepName}" (${step.stepDisplayName}) | ${step.pin} (${source}, ${context})`
}

main().catch((error) => {
    console.error('Framework census failed:', error)
    process.exit(1)
})
