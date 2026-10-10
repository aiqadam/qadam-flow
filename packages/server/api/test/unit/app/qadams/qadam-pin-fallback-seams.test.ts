import { FastifyBaseLogger } from 'fastify'
import { qadamPinFallbackSeams } from '../../../../src/app/qadams/pin-moves/qadam-pin-fallback-seams'
import { SnapshotExportSources } from '../../../../src/app/qadams/snapshot-export/snapshot-export-sources'

const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger
const NAME = '@aiqadam/qadam-fixture'

function seamsOver({ sources }: { sources: Partial<SnapshotExportSources> }): ReturnType<typeof qadamPinFallbackSeams> {
    return qadamPinFallbackSeams({
        log,
        sources: { releases: async () => null, releaseMetadata: async () => null, snapshotMetadata: async () => null, ...sources },
    })
}

describe('qadamPinFallbackSeams.pinMetadata: what the instance knows about the pinned version', () => {
    it('is unknown when the catalogue cannot be read: nothing is moved on a guess', async () => {
        expect(await seamsOver({ sources: { releases: async () => null } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
    })

    it('is unknown when the catalogue was read but cannot say whether entries were skipped', async () => {
        expect(await seamsOver({ sources: { releases: async () => ['0.5.2', '0.5.3'] } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
    })

    it('is never-published when the catalogue was read, skipped nothing and does not list the version', async () => {
        expect(await seamsOver({ sources: { skippedEntries: async () => 0, releases: async () => ['0.5.2', '0.5.3'] } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'never-published' })
        expect(await seamsOver({ sources: { skippedEntries: async () => 0, releases: async () => [] } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'never-published' })
    })

    it('is unknown when the version is not listed but entries were skipped, including when all were', async () => {
        for (const skipped of [1, 40]) {
            const seams = seamsOver({ sources: { releases: async () => ['0.5.2'], skippedEntries: async () => skipped } })

            expect(await seams.pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
        }
        expect(await seamsOver({ sources: { releases: async () => [], skippedEntries: async () => 3 } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
    })

    it('is never-published when nothing was skipped and the version is not listed', async () => {
        expect(await seamsOver({ sources: { releases: async () => ['0.5.2'], skippedEntries: async () => 0 } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'never-published' })
    })

    it('is the release\'s metadata when the catalogue lists it', async () => {
        const metadata = { actions: {} }
        const seams = seamsOver({ sources: { releases: async () => ['0.5.1'], releaseMetadata: async () => metadata } })

        expect(await seams.pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'found', metadata })
    })

    it('is unknown when the catalogue lists the version but its metadata cannot be read', async () => {
        expect(await seamsOver({ sources: { releases: async () => ['0.5.1'], releaseMetadata: async () => null } }).pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
    })

    it('reads a snapshot\'s metadata from the store, and never calls a missing one never-published', async () => {
        const metadata = { actions: {} }

        expect(await seamsOver({ sources: { snapshotMetadata: async () => metadata } }).pinMetadata({ name: NAME, version: '1.3.0-main.5' })).toEqual({ status: 'found', metadata })
        expect(await seamsOver({ sources: { releases: async () => [] } }).pinMetadata({ name: NAME, version: '1.3.0-main.5' })).toEqual({ status: 'unknown' })
    })

    it('is unknown when a source throws', async () => {
        const seams = seamsOver({ sources: { releases: async () => {
            throw new Error('socket hang up') 
        } } })

        expect(await seams.pinMetadata({ name: NAME, version: '0.5.1' })).toEqual({ status: 'unknown' })
    })
})
