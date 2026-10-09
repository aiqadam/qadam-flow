/* eslint-disable no-console */
import { openReadOnlyDatabaseConnection } from '../app/database/database-connection'
import { system } from '../app/helper/system/system'
import { frameworkCensusDoctorReport } from '../app/qadams/census/framework-census-doctor-report'
import { frameworkCensusPolicy } from '../app/qadams/census/framework-census-policy'
import { frameworkCensusService } from '../app/qadams/census/framework-census-service'

// The `doctor` command of ADR-0002 (#803): run it from the new image, against the live database,
// before switching the containers over, and it lists the steps the release will stop running.
//
//   docker compose run --rm --entrypoint node app packages/server/api/dist/src/scripts/framework-census-doctor.js
//
// It never runs migrations and never writes: its connection (`openReadOnlyDatabaseConnection`)
// does not migrate on start-up, unlike the application's, and it refuses to run unless Postgres
// confirms the session is read-only. A database that predates `contextVersion` (#802) reads as
// unknown, and unknown counts as still needing the old contract. It does not block anything by
// itself — the release starts normally and no flow is disabled (#435). Pass `--fail-on-findings`
// to exit 1 when a step will stop running or a flow version could not be read, for an operator
// that wants an automated gate. A database error ends the command with exit 1 rather than
// reporting a step it could not read as one that stops running.
async function main(): Promise<void> {
    const failOnFindings = process.argv.includes('--fail-on-findings')
    const dataSource = await openReadOnlyDatabaseConnection()
    try {
        const census = await frameworkCensusService(system.globalLogger()).censusOfInstance()
        const lines = frameworkCensusDoctorReport.lines({ census, retiredContextVersions: frameworkCensusPolicy.retiredContextVersions() })
        console.log(lines.join('\n'))
        process.exitCode = frameworkCensusDoctorReport.exitCode({ census, failOnFindings })
    }
    finally {
        await dataSource.destroy()
    }
}

main().catch((error) => {
    console.error('Framework census failed:', error)
    process.exit(1)
})
