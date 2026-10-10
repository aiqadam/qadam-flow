import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { qadamVersionStore, qadamVersionStoreSeed } from '@aiqadam/server-utils'
import { FlowActionType, FlowTriggerType, FlowVersion, FlowVersionState } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppSystemProp } from '../../../../src/app/helper/system/system-props'
import { qadamVersionCatalogueSource } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-source'
import { qadamVersionCatalogueWriter } from '../../../../src/app/qadams/catalogue/qadam-version-catalogue-writer'
import { snapshotExportSources } from '../../../../src/app/qadams/snapshot-export/snapshot-export-sources'
import { SnapshotExportMode, snapshotPinExport } from '../../../../src/app/qadams/snapshot-export/snapshot-pin-export'
import { catalogueFixtures } from './qadam-version-catalogue-fixtures'

// The real catalogue reader on a catalogue written by the real writer, and the real store reader on a
// store seeded the way an image seeds it: what the export's sources are made of, end to end, without
// a database.
const TABLES = '@aiqadam/qadam-tables'
const SNAPSHOT = '1.3.0-main.412'
const STORE_ENV = `AP_${AppSystemProp.QADAM_VERSION_STORE_PATH}`
const original = process.env[STORE_ENV]
const logger = pino({ level: 'silent' })
const warn = vi.spyOn(logger, 'warn')

let tempDir: string
let catalogueDir: string

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'snapshot-export-sources-')))
    catalogueDir = join(tempDir, 'catalog', 'v1')
    process.env[STORE_ENV] = join(tempDir, 'store')
    warn.mockClear()
    await writeCatalogue({ versions: ['1.3.0', '1.3.1', '1.4.0'], oneIncompatible: '1.4.0' })
    await seedStore({ versions: [SNAPSHOT] })
})

afterEach(async () => {
    if (original === undefined) {
        delete process.env[STORE_ENV]
    }
    else {
        process.env[STORE_ENV] = original
    }
    await rm(tempDir, { recursive: true, force: true })
})

describe('snapshotExportSources.forInstance', () => {
    it('lists the released versions of a qadam and reads a release metadata from the catalogue', async () => {
        const sources = forInstance()

        expect((await sources.releases({ name: TABLES })).sort()).toEqual(['1.3.0', '1.3.1', '1.4.0'])
        expect(await sources.releases({ name: '@aiqadam/qadam-none' })).toEqual([])
        expect(await sources.releaseMetadata({ name: TABLES, version: '1.3.1' })).toMatchObject({ name: TABLES, version: '1.3.1' })
        expect(await sources.releaseMetadata({ name: TABLES, version: '9.9.9' })).toBeNull()
    })

    it('reads the metadata.json of a snapshot out of the instance store, and null for one it does not hold', async () => {
        const sources = forInstance()

        expect(await sources.snapshotMetadata({ name: TABLES, version: SNAPSHOT })).toMatchObject({ name: TABLES, version: SNAPSHOT })
        expect(await sources.snapshotMetadata({ name: TABLES, version: '1.3.0-main.1' })).toBeNull()
    })

    it('answers unknown, never an error, when the catalogue or the store is unavailable', async () => {
        const sources = snapshotExportSources.forInstance({ log: logger, catalogueSource: qadamVersionCatalogueSource.directory({ root: join(tempDir, 'missing') }) })
        process.env[STORE_ENV] = join(tempDir, 'no-store')

        expect(await sources.releases({ name: TABLES })).toEqual([])
        expect(await sources.releaseMetadata({ name: TABLES, version: '1.3.0' })).toBeNull()
        expect(await sources.snapshotMetadata({ name: TABLES, version: SNAPSHOT })).toBeNull()
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ status: 'unavailable' }), expect.stringContaining('catalogue is unavailable'))
    })

    it('reads the catalogue once per export', async () => {
        const read = vi.fn(qadamVersionCatalogueSource.directory({ root: catalogueDir }).read)
        const sources = snapshotExportSources.forInstance({ log: logger, catalogueSource: { read } })

        await sources.releases({ name: TABLES })
        await sources.releaseMetadata({ name: TABLES, version: '1.3.0' })
        await sources.releases({ name: TABLES })

        expect(read.mock.calls.filter(([params]) => params.relativePath === 'index.json')).toHaveLength(1)
    })
})

describe('an export through the real catalogue reader and the real store', () => {
    it('moves a snapshot pin to the newest compatible release', async () => {
        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ qadamVersion: SNAPSHOT }), mode: SnapshotExportMode.REWRITE, sources: forInstance(), log: logger })

        expect(exported.trigger.nextAction?.type === FlowActionType.PIECE && exported.trigger.nextAction.settings.qadamVersion).toBe('1.3.1')
        expect(exported.exportedUnresolved).toBeUndefined()
    })

    it('flags the step when the instance holds no snapshot to compare with', async () => {
        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ qadamVersion: '1.3.0-main.1' }), mode: SnapshotExportMode.REWRITE, sources: forInstance(), log: logger })

        expect(exported.trigger.nextAction?.type === FlowActionType.PIECE && exported.trigger.nextAction.settings.qadamVersion).toBe('^1.3.0')
        expect(exported.exportedUnresolved).toHaveLength(1)
    })

    it('embeds the snapshot metadata.json when the snapshot is kept', async () => {
        const exported = await snapshotPinExport.apply({ flowVersion: flowVersion({ qadamVersion: SNAPSHOT }), mode: SnapshotExportMode.KEEP, sources: forInstance(), log: logger })

        expect(exported.snapshotMetadata?.[`${TABLES}@${SNAPSHOT}`]).toMatchObject({ name: TABLES, version: SNAPSHOT })
    })
})

function forInstance(): ReturnType<typeof snapshotExportSources.forInstance> {
    return snapshotExportSources.forInstance({ log: logger, catalogueSource: qadamVersionCatalogueSource.directory({ root: catalogueDir }) })
}

function tablesMetadata({ version, incompatible = false }: { version: string, incompatible?: boolean }): Record<string, unknown> {
    const props = incompatible ? {} : { a: { type: 'SHORT_TEXT', required: false } }
    return catalogueFixtures.metadata({ name: TABLES, version, overrides: { actions: { insert: { name: 'insert', displayName: 'Insert', description: 'Inserts', props, requireAuth: false } } } })
}

async function writeCatalogue({ versions, oneIncompatible }: { versions: string[], oneIncompatible: string }): Promise<void> {
    const archiveDir = join(tempDir, 'archive')
    await catalogueFixtures.writeArchive({ archiveDir, artifacts: versions.map((version) => ({ name: TABLES, version, metadata: tablesMetadata({ version, incompatible: version === oneIncompatible }) })) })
    const written = await qadamVersionCatalogueWriter.append({ catalogueDir, archiveDir })
    expect(written.status).toBe('appended')
}

async function seedStore({ versions }: { versions: string[] }): Promise<void> {
    const seedDir = join(tempDir, 'seed')
    await catalogueFixtures.writeArchive({ archiveDir: seedDir, artifacts: versions.map((version) => ({ name: TABLES, version, metadata: tablesMetadata({ version }) })) })
    const root = join(tempDir, 'store')
    await mkdir(root, { recursive: true })
    const opened = await qadamVersionStore.open({ root, log: { info: vi.fn(), warn: vi.fn() } })
    if (!opened.ok) {
        throw new Error(opened.reason)
    }
    const report = await qadamVersionStoreSeed.seedFromImage({ store: opened.store, seedDir, log: { info: vi.fn(), warn: vi.fn() } })
    expect(report.failed).toEqual([])
}

function flowVersion({ qadamVersion }: { qadamVersion: string }): FlowVersion {
    return {
        id: 'pj0KQ7Aypoa9OQGHzmKDl',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        flowId: 'lod6JEdKyPlvrnErdnrGa',
        displayName: 'Export',
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
        localeSource: null,
        trigger: {
            name: 'trigger',
            type: FlowTriggerType.EMPTY,
            valid: true,
            displayName: 'Trigger',
            lastUpdatedDate: '2026-10-10T00:00:00.000Z',
            settings: {},
            nextAction: {
                name: 'step_1',
                type: FlowActionType.PIECE,
                valid: true,
                displayName: 'Insert',
                lastUpdatedDate: '2026-10-10T00:00:00.000Z',
                settings: { qadamName: TABLES, qadamVersion, actionName: 'insert', propertySettings: {}, input: {}, errorHandlingOptions: {} },
            },
        },
    }
}
