import { qadamVersionStoreGcDecision } from '../src/qadam-version-store/qadam-version-store-gc-decision'
import { QadamVersionGcLedgerEntry } from '../src/qadam-version-store/qadam-version-store-gc-ledger'
import { QadamVersionCoordinates } from '../src/qadam-version-store/qadam-version-store-layout'

const OFFICIAL: QadamVersionCoordinates = { platformId: null, name: '@aiqadam/qadam-slack', version: '1.2.0' }
const CUSTOM: QadamVersionCoordinates = { platformId: 'platform-a', name: 'my-custom-qadam', version: '1.0.0' }

describe('qadamVersionStoreGcDecision.classify', () => {
    it('protects a version pinned by a flow version', () => {
        const result = qadamVersionStoreGcDecision.classify({
            stored: [OFFICIAL],
            pinnedKeys: new Set([qadamVersionStoreGcDecision.coordinateKey(OFFICIAL)]),
            imageVersions: new Set(),
            retainedKeys: new Set(),
        })
        expect(result.protectedVersions).toEqual([OFFICIAL])
        expect(result.unreferenced).toEqual([])
    })

    it('protects an official version the current image ships', () => {
        const result = qadamVersionStoreGcDecision.classify({
            stored: [OFFICIAL],
            pinnedKeys: new Set(),
            imageVersions: new Set(['@aiqadam/qadam-slack@1.2.0']),
            retainedKeys: new Set(),
        })
        expect(result.protectedVersions).toEqual([OFFICIAL])
    })

    it('never protects a custom version just because the image ships an official one at the same name@version string', () => {
        const customNamedLikeImage: QadamVersionCoordinates = { platformId: 'platform-a', name: '@aiqadam/qadam-slack', version: '1.2.0' }
        const result = qadamVersionStoreGcDecision.classify({
            stored: [customNamedLikeImage],
            pinnedKeys: new Set(),
            imageVersions: new Set(['@aiqadam/qadam-slack@1.2.0']),
            retainedKeys: new Set(),
        })
        // Unreachable in practice (the layout never lets an official name live in a platform
        // namespace), but the image-shipped exemption must still require platformId === null.
        expect(result.unreferenced).toEqual([customNamedLikeImage])
    })

    it('protects a version a pin move left as a step\'s revert target', () => {
        const result = qadamVersionStoreGcDecision.classify({
            stored: [CUSTOM],
            pinnedKeys: new Set(),
            imageVersions: new Set(),
            retainedKeys: new Set([qadamVersionStoreGcDecision.coordinateKey(CUSTOM)]),
        })
        expect(result.protectedVersions).toEqual([CUSTOM])
    })

    it('treats everything else as unreferenced', () => {
        const result = qadamVersionStoreGcDecision.classify({
            stored: [OFFICIAL, CUSTOM],
            pinnedKeys: new Set(),
            imageVersions: new Set(),
            retainedKeys: new Set(),
        })
        expect(result.unreferenced).toEqual([OFFICIAL, CUSTOM])
        expect(result.protectedVersions).toEqual([])
    })
})

describe('qadamVersionStoreGcDecision.coordinateKey', () => {
    it('always uses the official namespace for an official qadam name, regardless of a passed platformId', () => {
        const official = qadamVersionStoreGcDecision.coordinateKey({ name: '@aiqadam/qadam-slack', version: '1.2.0', platformId: 'some-platform' })
        expect(official).toBe(qadamVersionStoreGcDecision.coordinateKey({ name: '@aiqadam/qadam-slack', version: '1.2.0', platformId: null }))
    })

    it('keeps a custom qadam in its own platform namespace', () => {
        const a = qadamVersionStoreGcDecision.coordinateKey({ name: 'custom', version: '1.0.0', platformId: 'platform-a' })
        const b = qadamVersionStoreGcDecision.coordinateKey({ name: 'custom', version: '1.0.0', platformId: 'platform-b' })
        expect(a).not.toBe(b)
    })
})

describe('qadamVersionStoreGcDecision.selectEligible', () => {
    const now = new Date('2026-10-25T00:00:00.000Z')

    it('is not eligible before the retention window elapses', () => {
        const entries: QadamVersionGcLedgerEntry[] = [{ ...OFFICIAL, firstSeenUnreferencedAt: '2026-10-16T00:00:00.000Z' }]
        expect(qadamVersionStoreGcDecision.selectEligible({ entries, now, retentionDays: 10 })).toEqual([])
    })

    it('is eligible exactly at the retention window', () => {
        const entries: QadamVersionGcLedgerEntry[] = [{ ...OFFICIAL, firstSeenUnreferencedAt: '2026-10-15T00:00:00.000Z' }]
        expect(qadamVersionStoreGcDecision.selectEligible({ entries, now, retentionDays: 10 })).toEqual(entries)
    })

    it('is eligible well past the retention window, not just at it (a version pinned for a year and dropped an hour ago still waits out the full window from when it was tracked)', () => {
        const entries: QadamVersionGcLedgerEntry[] = [{ ...OFFICIAL, firstSeenUnreferencedAt: '2026-01-01T00:00:00.000Z' }]
        expect(qadamVersionStoreGcDecision.selectEligible({ entries, now, retentionDays: 10 })).toEqual(entries)
    })
})
