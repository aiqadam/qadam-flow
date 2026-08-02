import { FlowActionType, FlowTriggerType, FlowVersionState, LATEST_FLOW_SCHEMA_VERSION } from '@aiqadam/shared'
import type { FlowVersion } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRepoUpdate = vi.fn()
const mockBackupStore = vi.fn()

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionRepo: (): { update: typeof mockRepoUpdate } => ({ update: mockRepoUpdate }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version-backup.service', () => ({
    flowVersionBackupService: (): { store: typeof mockBackupStore } => ({ store: mockBackupStore }),
}))

// v24 reads the qadam registry to find the version it should pin AI steps to, so every path here
// that walks the chain past 24 needs one. None of these fixtures carries an AI step, so the
// contents only have to be a list.
vi.mock('../../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { registry: () => Promise<unknown[]> } => ({
        registry: async (): Promise<unknown[]> => [{ name: '@aiqadam/qadam-ai', version: '0.4.4' }],
    }),
}))

import { flowVersionMigrationService } from '../../../../../src/app/flows/flow-version/flow-version-migration.service'
import { flowMigrations } from '../../../../../src/app/flows/flow-version/migrations'
import { migrateV22RenamePieceToQadam } from '../../../../../src/app/flows/flow-version/migrations/migrate-v22-rename-piece-to-qadam'

const mockLog = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

// A version written before the piece -> qadam rename: its step settings still carry `pieceName`
// and `pieceVersion`, and v22 is the migration that turns them into `qadamName`/`qadamVersion`.
function preRenameFlowVersion(schemaVersion: string): FlowVersion {
    return {
        id: 'fv-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'legacy flow',
        updatedBy: null,
        valid: true,
        schemaVersion,
        agentIds: [],
        state: FlowVersionState.DRAFT,
        connectionIds: [],
        backupFiles: null,
        notes: [],
        trigger: {
            name: 'trigger',
            type: FlowTriggerType.PIECE,
            valid: true,
            displayName: 'Gmail Trigger',
            settings: {
                pieceName: '@aiqadam/piece-gmail',
                pieceVersion: '~0.1.0',
                triggerName: 'new_email',
                input: {},
                propertySettings: {},
            },
            nextAction: {
                name: 'step_1',
                type: FlowActionType.PIECE,
                valid: true,
                displayName: 'Slack Action',
                settings: {
                    pieceName: '@aiqadam/piece-slack',
                    pieceVersion: '~0.2.0',
                    actionName: 'send_channel_message',
                    input: {},
                    propertySettings: {},
                },
            },
        },
    } as unknown as FlowVersion
}

// A version written *after* the rename by `flowVersionService.createEmptyVersion`, which stamps
// `LATEST_FLOW_SCHEMA_VERSION` — so it sits at the same number as a version that came up the chain
// from v21, but its settings are already qadam-named.
function postRenameFlowVersion(schemaVersion: string): FlowVersion {
    const version = preRenameFlowVersion(schemaVersion)
    return migrateStepsToQadamNames(version)
}

function readNames(version: FlowVersion): { trigger: unknown, action: unknown } {
    const trigger = version.trigger as unknown as {
        settings: Record<string, unknown>
        nextAction: { settings: Record<string, unknown> }
    }
    return {
        trigger: { name: trigger.settings.qadamName, version: trigger.settings.qadamVersion },
        action: { name: trigger.nextAction.settings.qadamName, version: trigger.nextAction.settings.qadamVersion },
    }
}

function migrateStepsToQadamNames(version: FlowVersion): FlowVersion {
    const clone = JSON.parse(JSON.stringify(version)) as unknown as {
        trigger: { settings: Record<string, unknown>, nextAction: { settings: Record<string, unknown> } }
    }
    for (const settings of [clone.trigger.settings, clone.trigger.nextAction.settings]) {
        settings.qadamName = (settings.pieceName as string).replace('@aiqadam/piece-', '@aiqadam/qadam-')
        settings.qadamVersion = settings.pieceVersion
        delete settings.pieceName
        delete settings.pieceVersion
    }
    return clone as unknown as FlowVersion
}

function stripLegacyKeys(version: FlowVersion): FlowVersion {
    const clone = JSON.parse(JSON.stringify(version)) as unknown as {
        trigger: { settings: Record<string, unknown>, nextAction: { settings: Record<string, unknown> } }
    }
    for (const settings of [clone.trigger.settings, clone.trigger.nextAction.settings]) {
        delete settings.pieceName
        delete settings.pieceVersion
    }
    return clone as unknown as FlowVersion
}

describe('LATEST_FLOW_SCHEMA_VERSION vs the migration chain — #273 item 3', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockBackupStore.mockResolvedValue('backup-file-1')
        mockRepoUpdate.mockResolvedValue(undefined)
    })

    // `flowVersionMigrationService.migrate` early-exits on `=== LATEST_FLOW_SCHEMA_VERSION`, so that
    // constant must be a fixed point of the chain. While it was '22' the chain ran two more steps
    // past it and the early exit skipped them.
    it('is a fixed point of the migration chain', async () => {
        const atLatest = postRenameFlowVersion(LATEST_FLOW_SCHEMA_VERSION)

        const applied = await flowMigrations.apply(atLatest)

        expect(applied.schemaVersion).toBe(LATEST_FLOW_SCHEMA_VERSION)
    })

    it('migrates a version sitting at exactly 22 instead of skipping the rename', async () => {
        const migrated = await flowVersionMigrationService(mockLog).migrate(preRenameFlowVersion('22'))

        expect(migrated.schemaVersion).toBe('25')
        expect(readNames(migrated)).toEqual({
            trigger: { name: '@aiqadam/qadam-gmail', version: '~0.1.0' },
            action: { name: '@aiqadam/qadam-slack', version: '~0.2.0' },
        })
    })

    it('lands a version starting at 21 and one starting at 22 on the same trigger', async () => {
        const fromV21 = await flowVersionMigrationService(mockLog).migrate(preRenameFlowVersion('21'))
        const fromV22 = await flowVersionMigrationService(mockLog).migrate(preRenameFlowVersion('22'))

        expect(fromV22.schemaVersion).toBe(fromV21.schemaVersion)
        expect(fromV22.trigger).toEqual(fromV21.trigger)
    })

    // The early exit is the whole mechanism of the bug, and it is also what stops a version already
    // at the latest from writing a fresh backup file and an UPDATE on every single read. Deleting it
    // left every other test in this file green, so pin the persistence side directly.
    it('does not re-persist a version already at the latest', async () => {
        const atLatest = postRenameFlowVersion(LATEST_FLOW_SCHEMA_VERSION)

        const result = await flowVersionMigrationService(mockLog).migrate(atLatest)

        expect(result).toBe(atLatest)
        expect(mockRepoUpdate).not.toHaveBeenCalled()
        expect(mockBackupStore).not.toHaveBeenCalled()
    })

    it('persists the migrated version exactly once for a version below the latest', async () => {
        await flowVersionMigrationService(mockLog).migrate(preRenameFlowVersion('22'))

        expect(mockRepoUpdate).toHaveBeenCalledTimes(1)
        expect(mockRepoUpdate.mock.calls[0][1]).toMatchObject({ schemaVersion: '25' })
    })
})

// Raising the constant makes v22 run over every version currently stamped '22'. Two producers write
// that number: v21's output (pre-rename, needs v22) and `createEmptyVersion`, which post-dates the
// rename and writes already-qadam-named settings. v22 must be a no-op on the second cohort.
describe('migrateV22RenamePieceToQadam idempotency', () => {
    it('leaves an already-renamed version untouched', async () => {
        const alreadyRenamed = postRenameFlowVersion('22')

        const migrated = await migrateV22RenamePieceToQadam.migrate(alreadyRenamed)

        expect(readNames(migrated)).toEqual(readNames(alreadyRenamed))
        expect(migrated.trigger).toEqual({ ...alreadyRenamed.trigger })
    })

    // Two ways a second pass can reach v22: with the legacy keys still present, where it recomputes
    // from the untouched `pieceName`, and with them gone, where it has to carry `qadamName` through.
    // Feeding the derived value back is what makes this idempotency rather than determinism.
    it('produces the same result when applied twice, legacy keys kept', async () => {
        const once = await migrateV22RenamePieceToQadam.migrate(preRenameFlowVersion('22'))
        const twice = await migrateV22RenamePieceToQadam.migrate({ ...once, schemaVersion: '22' })

        expect(readNames(twice)).toEqual(readNames(once))
        expect(twice.trigger).toEqual(once.trigger)
    })

    it('produces the same result when applied twice, legacy keys dropped', async () => {
        const once = await migrateV22RenamePieceToQadam.migrate(preRenameFlowVersion('22'))
        const twice = await migrateV22RenamePieceToQadam.migrate(stripLegacyKeys({ ...once, schemaVersion: '22' }))

        expect(readNames(twice)).toEqual(readNames(once))
    })
})
