// Reject-case fixtures for validateMigrationInstance() (#445). Run via
// tools/ci/test-check-migration-rollback.sh, which is what actually executes
// in CI (_verify.yml, unconditional job) — this file must go red the moment
// the gate stops catching a missing breaking/release/down().
import { strict as assert } from 'assert'
import { MigrationCandidate, validateMigrationInstance } from '../scripts/check-migration-rollback'

const down = async (): Promise<void> => undefined

type Case = {
    name: string
    instance: MigrationCandidate
    expectSubstrings: string[]
}

const CASES: Case[] = [
    {
        name: 'missing name',
        instance: { breaking: false, release: '1.0.0', down },
        expectSubstrings: ['"name"'],
    },
    {
        name: 'missing breaking',
        instance: { name: 'X', release: '1.0.0', down },
        expectSubstrings: ['"breaking"'],
    },
    {
        name: 'invalid release semver',
        instance: { name: 'X', breaking: false, release: 'not-a-version', down },
        expectSubstrings: ['"release"'],
    },
    {
        name: 'missing release entirely',
        instance: { name: 'X', breaking: false, down },
        expectSubstrings: ['"release"'],
    },
    {
        name: 'non-breaking without down()',
        instance: { name: 'X', breaking: false, release: '1.0.0' },
        expectSubstrings: ['down()'],
    },
    {
        name: 'breaking without down() is allowed',
        instance: { name: 'X', breaking: true, release: '1.0.0' },
        expectSubstrings: [],
    },
    {
        name: 'fully valid migration',
        instance: { name: 'X', breaking: false, release: '1.0.0', down },
        expectSubstrings: [],
    },
]

function main(): void {
    let failures = 0

    for (const testCase of CASES) {
        const errors = validateMigrationInstance(testCase.instance)

        try {
            if (testCase.expectSubstrings.length === 0) {
                assert.deepEqual(errors, [], `expected no errors, got: ${JSON.stringify(errors)}`)
            }
            else {
                for (const substring of testCase.expectSubstrings) {
                    assert.ok(
                        errors.some((error) => error.includes(substring)),
                        `expected an error containing "${substring}", got: ${JSON.stringify(errors)}`,
                    )
                }
            }
            console.log(`PASS  ${testCase.name}`)
        }
        catch (error) {
            failures += 1
            console.error(`FAIL  ${testCase.name}: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    if (failures > 0) {
        console.error(`\n${failures}/${CASES.length} case(s) failed.`)
        process.exit(1)
    }

    console.log(`\nAll ${CASES.length} case(s) passed.`)
}

main()
