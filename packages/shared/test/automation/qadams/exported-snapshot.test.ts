import {
    EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES,
    EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES,
    EmbeddedSnapshotMetadataMap,
    ExportedUnresolvedStep,
    GetFlowTemplateRequestQuery,
} from '../../../src'

// ADR-0004 "Export and import": the embedded `metadata.json` of a kept snapshot is read by an
// importer that did not write it, so its shape and size are checked on every read.
const NAME = '@aiqadam/qadam-tables'
const VERSION = '1.3.0-main.412'

describe('EmbeddedSnapshotMetadataMap', () => {
    it('accepts a metadata file keyed by its own coordinates', () => {
        const result = EmbeddedSnapshotMetadataMap.safeParse({ [`${NAME}@${VERSION}`]: metadata({}) })

        expect(result.success).toBe(true)
    })

    it('keeps what the file says beyond the props surface', () => {
        const result = EmbeddedSnapshotMetadataMap.safeParse({ [`${NAME}@${VERSION}`]: { ...metadata({}), displayName: 'Tables' } })

        expect(result.success && result.data[`${NAME}@${VERSION}`]['displayName']).toBe('Tables')
    })

    it.each([
        ['an entry under another key', { [`${NAME}@1.3.0-main.1`]: metadata({}) }],
        ['a release rather than a snapshot', { [`${NAME}@1.3.0`]: metadata({ version: '1.3.0' }) }],
        ['another prerelease', { [`${NAME}@1.3.0-rc.1`]: metadata({ version: '1.3.0-rc.1' }) }],
        ['actions that are not objects', { [`${NAME}@${VERSION}`]: { ...metadata({}), actions: { a: 'x' } } }],
        ['a prop without a type', { [`${NAME}@${VERSION}`]: { ...metadata({}), actions: { a: { props: { p: {} } } } } }],
        ['no triggers', { [`${NAME}@${VERSION}`]: { name: NAME, version: VERSION, actions: {} } }],
    ])('rejects %s', (_label, value) => {
        expect(EmbeddedSnapshotMetadataMap.safeParse(value).success).toBe(false)
    })

    it('rejects one entry over the size bound', () => {
        const big = { a: { props: { p: { type: 'SHORT_TEXT', description: 'x'.repeat(EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES) } } } }

        expect(EmbeddedSnapshotMetadataMap.safeParse({ [`${NAME}@${VERSION}`]: metadata({ actions: big }) }).success).toBe(false)
    })

    it('measures the size in bytes, not characters', () => {
        const wide = { a: { props: { p: { type: 'SHORT_TEXT', description: '\u00e9'.repeat(EMBEDDED_SNAPSHOT_METADATA_MAX_BYTES / 2) } } } }

        expect(EmbeddedSnapshotMetadataMap.safeParse({ [`${NAME}@${VERSION}`]: metadata({ actions: wide }) }).success).toBe(false)
    })

    it('rejects more entries than the bound', () => {
        const entries = Object.fromEntries(Array.from({ length: EMBEDDED_SNAPSHOT_METADATA_MAX_ENTRIES + 1 }, (_, index) => {
            const version = `1.3.0-main.${index + 1}`
            return [`${NAME}@${version}`, metadata({ version })]
        }))

        expect(EmbeddedSnapshotMetadataMap.safeParse(entries).success).toBe(false)
    })
})

describe('ExportedUnresolvedStep', () => {
    it('carries an optional reason, from a closed set', () => {
        const step = { stepName: 'step_1', qadamName: NAME, pin: VERSION }

        expect(ExportedUnresolvedStep.safeParse(step).success).toBe(true)
        expect(ExportedUnresolvedStep.safeParse({ ...step, reason: 'metadata-unavailable' }).success).toBe(true)
        expect(ExportedUnresolvedStep.safeParse({ ...step, reason: 'because' }).success).toBe(false)
    })
})

describe('GetFlowTemplateRequestQuery', () => {
    it.each([
        [{}, undefined, undefined],
        [{ sameInstance: 'true' }, true, undefined],
        [{ sameInstance: 'false', keepSnapshots: 'true' }, false, true],
        [{ keepSnapshots: 'yes' }, undefined, undefined],
    ])('reads %j', (query, sameInstance, keepSnapshots) => {
        const parsed = GetFlowTemplateRequestQuery.parse(query)

        expect(parsed.sameInstance).toBe(sameInstance)
        expect(parsed.keepSnapshots).toBe(keepSnapshots)
    })
})

function metadata({ version = VERSION, actions = {} }: { version?: string, actions?: Record<string, unknown> }): Record<string, unknown> {
    return { name: NAME, version, actions, triggers: {} }
}
