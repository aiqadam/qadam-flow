// Manual operator tool, not a CI step (#445 considered and rejected wiring it
// in). It previews `rollbackToManifest()`'s candidate list for a given target
// manifest, so it is only useful with a manifest of migration names already
// applied on the instance being rolled back — CI has no way to obtain that
// for a tag build, since it would require live introspection of a running
// deployment. Run it by hand (`npm run check-manifest-migrations -- '[...]'`)
// before a manifest-based `node dist/src/rollback.js` on a real deployment.
import * as fs from 'fs'
import { identifyCandidatesByManifest } from '../../packages/server/api/src/app/database/rollback-migrations'
import { getMigrations } from '../../packages/server/api/src/app/database/postgres-connection'

function main(): void {
    const manifestArg = process.argv[2]
    if (!manifestArg) {
        console.error('Usage: check-manifest-migrations.ts <manifest-json>')
        console.error('  manifest-json: JSON array of migration names present in the target image')
        console.error('  Example: check-manifest-migrations.ts \'["MigA","MigB"]\'')
        process.exit(1)
    }

    let targetMigrationNames: string[]
    try {
        const parsed: unknown[] = JSON.parse(manifestArg)
        if (!Array.isArray(parsed)) {
            throw new Error('Must be a JSON array')
        }
        targetMigrationNames = parsed.filter((n): n is string => typeof n === 'string')
    }
    catch (e) {
        console.error(`Invalid manifest JSON: ${e instanceof Error ? e.message : String(e)}`)
        process.exit(1)
    }

    const migrationClasses = getMigrations()
    const candidates = identifyCandidatesByManifest(migrationClasses, targetMigrationNames)
    const breakingMigrations = candidates.filter((m) => m.breaking === true)

    const outputFile = process.env.GITHUB_OUTPUT
    if (outputFile) {
        fs.appendFileSync(outputFile, `migration_count=${candidates.length}\n`)
        fs.appendFileSync(outputFile, `has_breaking=${breakingMigrations.length > 0}\n`)
        fs.appendFileSync(outputFile, `breaking_names=${breakingMigrations.map((m) => m.name ?? 'unknown').join(', ')}\n`)
    }

    if (candidates.length === 0) {
        console.log('No migrations to roll back — database already matches the target manifest.')
        return
    }

    console.log(`Found ${candidates.length} migration(s) to roll back:`)
    for (const m of candidates) {
        const label = m.breaking === true ? 'BREAKING' : 'safe'
        console.log(`  ${label}: ${m.name ?? 'unknown'}`)
    }

    if (breakingMigrations.length > 0) {
        console.log(`\n${breakingMigrations.length} breaking migration(s) detected.`)
    }
}

main()
