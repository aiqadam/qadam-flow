// Required check on every PR (#445) — see _verify.yml's "Check new migration
// metadata" step. Validates new migration files against
// rollback-migrations.ts's expectations, which read `breaking`/`release`/
// `down()` off every registered migration and silently mis-behave (skip a
// version, or roll back destructively without --force) when one is missing.
import { execFileSync } from 'child_process'
import * as path from 'path'
import semver from 'semver'

export function validateMigrationInstance(instance: MigrationCandidate): string[] {
    const errors: string[] = []

    // rollback-migrations.ts's identifyCandidatesByManifest() filters on `m.name`
    // and verifyDatabaseState() compares it against the `migrations` table by
    // position — a migration with no `name` silently drops out of a
    // manifest-based rollback instead of failing loudly.
    if (!instance.name || instance.name.trim() === '') {
        errors.push('Missing "name" property (must match the exported class name)')
    }

    if (instance.breaking === undefined) {
        errors.push('Missing "breaking" property (must be set to true or false)')
    }

    if (!instance.release || !semver.valid(instance.release)) {
        errors.push("Missing or invalid \"release\" property (must be valid semver, e.g. release = '0.78.0')")
    }

    if (instance.breaking !== true && typeof instance.down !== 'function') {
        errors.push('Missing down() method (required for non-breaking migrations)')
    }

    return errors
}

const MIGRATION_DIRS = [
    'packages/server/api/src/app/database/migration/postgres',
    'packages/server/api/src/app/database/migration/common',
]

const REPO_ROOT = path.resolve(__dirname, '../..')

// `origin/<base>...HEAD` is a branch-ref fallback for local/manual runs. In CI
// the exact PR_BASE_SHA/PR_HEAD_SHA (from github.event.pull_request.{base,head}.sha)
// are used instead — a branch ref can move between checkout and this step running,
// which is exactly the class of flakiness ci.yml's own `changes`/e2e jobs avoid by
// diffing fixed SHAs rather than `origin/<branch>`.
function getChangedMigrationFiles(): string[] {
    const { PR_BASE_SHA, PR_HEAD_SHA } = process.env
    const range = PR_BASE_SHA && PR_HEAD_SHA
        ? `${PR_BASE_SHA}...${PR_HEAD_SHA}`
        : `origin/${process.env.GITHUB_BASE_REF ?? 'main'}...HEAD`

    // execFileSync, not execSync + a template-literal command string: it spawns
    // git directly with an argv array rather than through a shell, so `range`
    // cannot be interpreted as shell syntax regardless of what it contains.
    const diffOutput = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '--diff-filter=A', range],
        { encoding: 'utf-8' },
    ).trim()

    if (!diffOutput) {
        return []
    }

    return diffOutput
        .split('\n')
        .filter((file) =>
            MIGRATION_DIRS.some((dir) => file.startsWith(dir)) && file.endsWith('.ts'),
        )
}

async function checkMigrationFile(filePath: string): Promise<string[]> {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(REPO_ROOT, filePath)

    // A migration missing e.g. `down()` fails to compile against typeorm's own
    // `MigrationInterface` before this ever runs — that is a real rejection, just
    // one ts-node reports on the import itself rather than as a validation error,
    // so surface it as one instead of letting a raw TSError stack through.
    let mod: unknown
    try {
        mod = await import(absolutePath)
    }
    catch (error) {
        return [`Failed to load migration file: ${error instanceof Error ? error.message : String(error)}`]
    }

    if (typeof mod !== 'object' || mod === null) {
        return ['No exported migration class found']
    }

    const MigrationClass = Object.values(mod).find(
        (v): v is new () => MigrationCandidate => typeof v === 'function' && Boolean(v.prototype?.up),
    )

    if (!MigrationClass) {
        return ['No exported migration class found']
    }

    const instance = new MigrationClass()
    const errors = validateMigrationInstance(instance)

    // validateMigrationInstance() only checks presence — this is the part of
    // "must match the exported class name" it can't do, since it never sees
    // the class itself, only the instance.
    if (instance.name && instance.name !== MigrationClass.name) {
        errors.push(`"name" ('${instance.name}') does not match the exported class name ('${MigrationClass.name}')`)
    }

    return errors
}

async function main(): Promise<void> {
    const changedFiles = getChangedMigrationFiles()

    if (changedFiles.length === 0) {
        console.log('No new migration files detected.')
        process.exit(0)
    }

    console.log(`Checking ${changedFiles.length} new migration file(s)...\n`)

    let hasErrors = false

    for (const file of changedFiles) {
        const errors = await checkMigrationFile(file)
        if (errors.length > 0) {
            hasErrors = true
            console.error(`❌ ${file}:`)
            for (const error of errors) {
                console.error(`   - ${error}`)
            }
            console.error()
        }
        else {
            console.log(`✅ ${file}`)
        }
    }

    if (hasErrors) {
        console.error('\nMigration rollback checks failed. See errors above.')
        console.error('All new migrations must:')
        console.error('  1. Set name = \'<ExportedClassName>\'')
        console.error('  2. Set breaking = true or breaking = false')
        console.error("  3. Set release = '<semver>' (e.g. '0.78.0')")
        console.error('  4. Have a down() method (unless breaking = true)')
        process.exit(1)
    }

    console.log('\n✅ All migration rollback checks passed.')
}

if (require.main === module) {
    main()
}

// Deliberately looser than `Migration`: typeorm's own `MigrationInterface.down`
// is non-optional, so a dynamically-imported instance that is missing it at
// runtime (the case validateMigrationInstance() exists to reject) does not
// satisfy `Migration` at all — this type describes the untrusted shape
// actually being validated.
export type MigrationCandidate = {
    name?: string
    breaking?: boolean
    release?: string
    down?: unknown
}
