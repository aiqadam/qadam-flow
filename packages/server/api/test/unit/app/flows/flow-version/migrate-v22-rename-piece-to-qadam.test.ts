import { FlowActionType, FlowVersion } from '@aiqadam/shared'
import { describe, expect, it } from 'vitest'
import { migrateV22RenamePieceToQadam } from '../../../../../src/app/flows/flow-version/migrations/migrate-v22-rename-piece-to-qadam'

function pieceFlowVersion({ schemaVersion, pieceName }: { schemaVersion: string, pieceName: unknown }): FlowVersion {
    return {
        id: 'flow-version-1',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        flowId: 'flow-1',
        displayName: 'piece flow',
        valid: true,
        state: 'DRAFT',
        schemaVersion,
        trigger: {
            name: 'trigger',
            type: 'EMPTY',
            valid: true,
            displayName: 'Select Trigger',
            settings: {},
            nextAction: {
                name: 'step_1',
                type: FlowActionType.PIECE,
                valid: true,
                displayName: 'Send Slack Message',
                settings: {
                    pieceName,
                    pieceVersion: '0.1.0',
                    actionName: 'send_channel_message',
                    input: {},
                    inputUiInfo: {},
                },
            },
        },
    } as unknown as FlowVersion
}

function readSettings(version: FlowVersion): Record<string, unknown> {
    return (version.trigger as unknown as { nextAction: { settings: Record<string, unknown> } }).nextAction.settings
}

// #1028: `pieceName` is cast straight to `string` and passed to `.replace`. Nothing upstream
// guarantees it is actually a string — a non-string value throws `TypeError`, which
// `flowVersionMigrationService.migrate` rethrows and pages on-call for, 500ing every read of that
// flow version.
describe('migrateV22RenamePieceToQadam — #1028', () => {
    it('still renames a step with a proper string pieceName', async () => {
        const version = pieceFlowVersion({ schemaVersion: '22', pieceName: '@aiqadam/piece-slack' })

        const migrated = await migrateV22RenamePieceToQadam.migrate(version)

        expect(readSettings(migrated).qadamName).toBe('@aiqadam/qadam-slack')
        expect(migrated.schemaVersion).toBe('23')
    })

    it.each([
        ['a number', 42],
        ['an object', { foo: 'bar' }],
    ])('leaves the step untouched when pieceName is %s', async (_label, pieceName) => {
        const version = pieceFlowVersion({ schemaVersion: '22', pieceName })

        const migrated = await migrateV22RenamePieceToQadam.migrate(version)

        expect(readSettings(migrated).pieceName).toEqual(pieceName)
        expect(readSettings(migrated).qadamName).toBeUndefined()
        expect(migrated.schemaVersion).toBe('23')
    })

    // `null` is the case the issue called out explicitly: `name.replace` on `null` throws just like
    // on any other non-string.
    it('leaves the step untouched when pieceName is null', async () => {
        const version = pieceFlowVersion({ schemaVersion: '22', pieceName: null })

        const migrated = await migrateV22RenamePieceToQadam.migrate(version)

        expect(readSettings(migrated).pieceName).toBeNull()
        expect(readSettings(migrated).qadamName).toBeUndefined()
        expect(migrated.schemaVersion).toBe('23')
    })
})
