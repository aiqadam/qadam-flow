import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { system } from '../../../../src/app/helper/system/system'
import { ContainerType } from '../../../../src/app/helper/system/system-props'

// These drive system.getContainerType() — the accessor every consumer goes through — rather than
// validateEnvPropsOnStartup. That function runs inside setupApp, which server.ts only reaches
// behind `if (system.isApp())`, so a container-type check placed there can never fire for the
// values it exists to reject. Testing the accessor is testing the path a real process takes.
const withContainerType = (value: string | undefined, run: () => void): void => {
    const previous = process.env.AP_CONTAINER_TYPE
    if (value === undefined) {
        delete process.env.AP_CONTAINER_TYPE
    }
    else {
        process.env.AP_CONTAINER_TYPE = value
    }
    try {
        run()
    }
    finally {
        if (previous === undefined) {
            delete process.env.AP_CONTAINER_TYPE
        }
        else {
            process.env.AP_CONTAINER_TYPE = previous
        }
    }
}

describe('system.getContainerType', () => {
    it.each([ContainerType.APP, ContainerType.WORKER])('accepts %s', (value) => {
        withContainerType(value, () => {
            expect(system.getContainerType()).toBe(value)
        })
    })

    // Absence is the case this exists for. Before #211 an unset value meant WORKER_AND_APP, which
    // is how a process ended up serving HTTP with no worker behind it; docker-entrypoint.sh already
    // refuses to start without it, and the published breaking-change note says there is no default.
    it('rejects an unset value rather than defaulting', () => {
        withContainerType(undefined, () => {
            expect(() => system.getContainerType()).toThrow(/AP_CONTAINER_TYPE is required and has no default/)
        })
    })

    it('names WORKER_AND_APP specifically, so an operator on the removed value gets an explanation', () => {
        withContainerType('WORKER_AND_APP', () => {
            expect(() => system.getContainerType()).toThrow(/WORKER_AND_APP has been removed/)
        })
    })

    // Each of these used to make isApp() and isWorker() *both* false, which is worse than a crash:
    // the process bound its port with no routes, no database and no worker while /api/v1/health
    // still answered 200 Healthy. They must throw, not resolve to neither.
    it.each([
        ['blank', '   '],
        ['lower-cased', 'app'],
        ['unrecognised', 'BOTH'],
    ])('rejects a %s value instead of leaving isApp() and isWorker() both false', (_label, value) => {
        withContainerType(value, () => {
            expect(() => system.getContainerType()).toThrow(/AP_CONTAINER_TYPE/)
            expect(() => system.isApp()).toThrow()
            expect(() => system.isWorker()).toThrow()
        })
    })

    // The validator's own comment cites a trailing CR from a file edited on Windows as something
    // config handling must tolerate. It has to be tolerated here too, or it lands in the branch
    // above and takes down a deployment over a line ending.
    it.each(['APP ', 'APP\r'])('tolerates whitespace-padded %j the way the other env checks do', (value) => {
        withContainerType(value, () => {
            expect(system.getContainerType()).toBe(ContainerType.APP)
            expect(system.isApp()).toBe(true)
        })
    })

    it.each([
        [ContainerType.APP, true, false],
        [ContainerType.WORKER, false, true],
    ])('%s selects exactly one of isApp/isWorker', (value, app, worker) => {
        withContainerType(value, () => {
            expect(system.isApp()).toBe(app)
            expect(system.isWorker()).toBe(worker)
        })
    })
})

// "Done when" item 2 of #211: dev and test must keep starting the same subsystems they did before
// the WORKER_AND_APP default was removed — demonstrated, not asserted. Both files pin
// AP_CONTAINER_TYPE=APP (added in 0d8eedd, before this ticket), so neither ever reached the removed
// default; these fail if either line is dropped, which is the only way removing it could change
// dev or test behaviour.
describe('#211: dev and test environments pin the container type explicitly', () => {
    const envFileContainerType = (relativeToRepoRoot: string): string | undefined => {
        const repoRoot = path.resolve(__dirname, '../../../../../../..')
        const contents = readFileSync(path.join(repoRoot, relativeToRepoRoot), 'utf-8')
        return contents
            .split('\n')
            .map((line) => /^\s*AP_CONTAINER_TYPE\s*=\s*(.*?)\s*$/.exec(line))
            .find((match) => match !== null)?.[1]
    }

    it.each(['.env.dev', 'packages/server/api/.env.tests'])('%s sets AP_CONTAINER_TYPE to a supported value', (file) => {
        expect(envFileContainerType(file)).toBe(ContainerType.APP)
    })

    // The running process is the test environment, so this reads the outcome rather than the file.
    it('the running test process selects the app subsystems, not the worker ones', () => {
        expect(process.env.AP_CONTAINER_TYPE).toBe(ContainerType.APP)
        expect(system.isApp()).toBe(true)
        expect(system.isWorker()).toBe(false)
    })
})
