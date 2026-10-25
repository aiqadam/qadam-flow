import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QadamVersionCoordinates, QadamVersionOrigin, QadamVersionPutStatus, qadamVersionStore } from '@aiqadam/server-utils'
import { apId, FlowTrigger, FlowTriggerType, FlowVersion, FlowVersionState } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamVersionStoreGc } from '../../../../src/app/qadams/version-store/qadam-version-store-gc'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
import { createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const SEED_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_SEED_PATH}`
const RETENTION_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_GC_RETENTION_DAYS}`
const original = { store: process.env[STORE_ENV], seed: process.env[SEED_ENV], retention: process.env[RETENTION_ENV] }

let app: FastifyInstance
let tempDir: string
let root: string
let seedDir: string

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'qadam-version-store-gc-test-')))
    root = join(tempDir, 'store')
    seedDir = join(tempDir, 'seed')
    process.env[STORE_ENV] = root
    process.env[SEED_ENV] = seedDir
})

afterEach(async () => {
    restoreEnv({ name: STORE_ENV, value: original.store })
    restoreEnv({ name: SEED_ENV, value: original.seed })
    restoreEnv({ name: RETENTION_ENV, value: original.retention })
    await rm(tempDir, { recursive: true, force: true })
})

describe('qadamVersionStoreGc (#478)', () => {
    it('never collects a version pinned by a draft flow version', async () => {
        const ctx = await createTestContext(app)
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        await writeStoredVersion({ coordinates })
        await seedFlow({ ctx, qadamName: qadam, qadamVersion: '1.0.0' })

        const report = await qadamVersionStoreGc(app.log).run()

        expect(report.removed).toBe(0)
        expect(await hasVersion({ coordinates })).toBe(true)
    })

    it('never collects a version the current image ships', async () => {
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        await writeStoredVersion({ coordinates })
        await mkdir(seedDir, { recursive: true })
        await writeFile(join(seedDir, 'archive-index.json'), JSON.stringify({
            formatVersion: 1,
            artifacts: [{ name: qadam, version: '1.0.0', file: 'x.tgz', integrity: 'sha512-AAAA' }],
        }))

        await qadamVersionStoreGc(app.log).run()

        expect(await hasVersion({ coordinates })).toBe(true)
    })

    it('does not collect a version before the retention window elapses', async () => {
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        await writeStoredVersion({ coordinates })

        // Default retention is 10 days; a second run the same instant does not cross it.
        await qadamVersionStoreGc(app.log).run()
        await qadamVersionStoreGc(app.log).run()

        expect(await hasVersion({ coordinates })).toBe(true)
    })

    it('collects a version unreferenced for at least the retention window, after tracking it on the first run', async () => {
        // A 0-day retention is no grace period at all: a version found unreferenced is eligible the
        // same run it is first tracked.
        process.env[RETENTION_ENV] = '0'
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        await writeStoredVersion({ coordinates })

        const report = await qadamVersionStoreGc(app.log).run()

        expect(report.removed).toBe(1)
        expect(await hasVersion({ coordinates })).toBe(false)
    })

    it('keeps the last N versions a pin move left a step pinned to, even past the retention window', async () => {
        process.env[RETENTION_ENV] = '0'
        const ctx = await createTestContext(app)
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        const { flow, flowVersion } = await seedFlow({ ctx, qadamName: qadam, qadamVersion: '2.0.0' })
        await writeStoredVersion({ coordinates })
        await savePinMove({ ctx, flow, flowVersion, qadamName: qadam, fromVersion: '1.0.0', toVersion: '2.0.0' })

        await qadamVersionStoreGc(app.log).run()
        await qadamVersionStoreGc(app.log).run()

        expect(await hasVersion({ coordinates })).toBe(true)
    })

    it('collects a version a pin move left behind once it falls off the kept count', async () => {
        process.env[RETENTION_ENV] = '0'
        const ctx = await createTestContext(app)
        const qadam = fixtureQadamName()
        const coordinates: QadamVersionCoordinates = { platformId: null, name: qadam, version: '1.0.0' }
        const { flow, flowVersion } = await seedFlow({ ctx, qadamName: qadam, qadamVersion: '5.0.0' })
        await writeStoredVersion({ coordinates })
        // The default keeps the last 3; four more recent moves (distinct, increasing timestamps so
        // the ranking is deterministic) push '1.0.0' out of the window.
        const moves: [string, string][] = [['1.0.0', '2.0.0'], ['2.0.0', '3.0.0'], ['3.0.0', '4.0.0'], ['4.0.0', '5.0.0']]
        for (const [index, [from, to]] of moves.entries()) {
            await savePinMove({ ctx, flow, flowVersion, qadamName: qadam, fromVersion: from, toVersion: to, createdAt: new Date(2026, 0, index + 1).toISOString() })
        }

        await qadamVersionStoreGc(app.log).run()
        await qadamVersionStoreGc(app.log).run()

        expect(await hasVersion({ coordinates })).toBe(false)
    })

    it('scopes a custom qadam version to its own platform namespace', async () => {
        const ctx = await createTestContext(app)
        const qadam = fixtureQadamName({ official: false })
        const coordinates: QadamVersionCoordinates = { platformId: ctx.platform.id, name: qadam, version: '1.0.0' }
        await writeStoredVersion({ coordinates })
        await seedFlow({ ctx, qadamName: qadam, qadamVersion: '1.0.0' })

        await qadamVersionStoreGc(app.log).run()

        expect(await hasVersion({ coordinates })).toBe(true)
    })

    it('reports a non-zero store size while a version is present', async () => {
        const qadam = fixtureQadamName()
        await writeStoredVersion({ coordinates: { platformId: null, name: qadam, version: '1.0.0' } })

        const report = await qadamVersionStoreGc(app.log).run()

        expect(report.totalBytes).toBeGreaterThan(0)
        expect(report.scanned).toBeGreaterThanOrEqual(1)
    })
})

function fixtureQadamName({ official = true }: { official?: boolean } = {}): string {
    const suffix = randomUUID().replace(/-/g, '')
    return official ? `@aiqadam/qadam-gc-fixture-${suffix}` : `gc-fixture-${suffix}`
}

async function writeStoredVersion({ coordinates }: { coordinates: QadamVersionCoordinates }): Promise<void> {
    const opened = await qadamVersionStore.open({ root, log: app.log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    const stagingDir = await opened.store.createStaging()
    await writeFile(join(stagingDir, 'package.json'), JSON.stringify({ name: coordinates.name, version: coordinates.version, main: './index.js' }))
    await writeFile(join(stagingDir, 'metadata.json'), JSON.stringify({ name: coordinates.name, version: coordinates.version, displayName: coordinates.name, actions: {}, triggers: {} }))
    await writeFile(join(stagingDir, 'index.js'), 'module.exports = {}\n')
    const result = await opened.store.commit({ coordinates, stagingDir, origin: { kind: QadamVersionOrigin.REGISTRY, tarballIntegrity: null } })
    if (result.status !== QadamVersionPutStatus.STORED) {
        throw new Error(`could not write the fixture version: ${JSON.stringify(result)}`)
    }
}

async function hasVersion({ coordinates }: { coordinates: QadamVersionCoordinates }): Promise<boolean> {
    const opened = await qadamVersionStore.open({ root, log: app.log })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    return opened.store.has({ coordinates })
}

async function seedFlow({ ctx, qadamName, qadamVersion }: { ctx: TestContext, qadamName: string, qadamVersion: string }): Promise<{ flow: { id: string }, flowVersion: FlowVersion }> {
    const flow = createMockFlow({ projectId: ctx.project.id })
    await db.save('flow', flow)
    const trigger: FlowTrigger = {
        type: FlowTriggerType.PIECE,
        name: 'step_1',
        displayName: 'Trigger',
        valid: true,
        lastUpdatedDate: new Date().toISOString(),
        settings: {
            qadamName,
            qadamVersion,
            triggerName: 'do_it',
            input: {},
            propertySettings: {},
        },
    }
    const flowVersion = createMockFlowVersion({ flowId: flow.id, updatedBy: ctx.user.id, state: FlowVersionState.DRAFT, valid: true, trigger })
    await db.save('flow_version', flowVersion)
    return { flow, flowVersion }
}

async function savePinMove({ ctx, flow, flowVersion, qadamName, fromVersion, toVersion, createdAt = new Date().toISOString() }: {
    ctx: TestContext
    flow: { id: string }
    flowVersion: FlowVersion
    qadamName: string
    fromVersion: string
    toVersion: string
    createdAt?: string
}): Promise<void> {
    await db.save('qadam_pin_move', {
        id: apId(),
        created: createdAt,
        updated: createdAt,
        platformId: ctx.platform.id,
        projectId: ctx.project.id,
        flowId: flow.id,
        flowVersionId: flowVersion.id,
        stepName: 'step_1',
        qadamName,
        fromVersion,
        toVersion,
        propsCheck: 'not-checked-no-metadata',
        cause: 'PUBLISH',
        status: 'APPLIED',
        movedBy: ctx.user.id,
        revertedAt: null,
        revertedBy: null,
    })
}

function restoreEnv({ name, value }: { name: string, value: string | undefined }): void {
    if (value === undefined) {
        delete process.env[name]
    }
    else {
        process.env[name] = value
    }
}
