import { qadamDistIndex } from '../../src/lib/helper/qadam-dist-index'
import { qadamLoader } from '../../src/lib/helper/qadam-loader'
import { qadamPinFallback } from '../../src/lib/helper/qadam-pin-fallback'

describe('qadamPinFallback.check', () => {
    it.each([
        { pinnedVersion: '1.2.0', imageVersion: '1.2.0', allowed: true },
        { pinnedVersion: '1.2.0', imageVersion: '1.9.4', allowed: true },
        { pinnedVersion: '0.3.1', imageVersion: '0.3.5', allowed: true },
        { pinnedVersion: '1.2.0', imageVersion: '1.1.9', allowed: false },
        { pinnedVersion: '1.2.0', imageVersion: '2.0.0', allowed: false },
        { pinnedVersion: '0.3.1', imageVersion: '0.4.0', allowed: false },
        { pinnedVersion: '0.3.5', imageVersion: '0.3.1', allowed: false },
        { pinnedVersion: '0.0.3', imageVersion: '0.0.4', allowed: false },
        { pinnedVersion: '1.2.0', imageVersion: null, allowed: false },
    ])('pin $pinnedVersion with the image at $imageVersion: allowed $allowed', ({ pinnedVersion, imageVersion, allowed }) => {
        expect(qadamPinFallback.check({ pinnedVersion, imageVersion }).allowed).toBe(allowed)
    })

    it('never gives a snapshot pin a substitute, whatever the image holds', () => {
        for (const imageVersion of ['1.3.0', '1.3.0-main.500', '1.4.0', '1.3.0-main.412']) {
            const verdict = qadamPinFallback.check({ pinnedVersion: '1.3.0-main.412', imageVersion })
            expect(verdict.allowed).toBe(false)
            expect(verdict).toMatchObject({ reason: expect.stringContaining('#808') })
        }
    })

    it('never gives a release pin a snapshot build', () => {
        expect(qadamPinFallback.check({ pinnedVersion: '1.2.0', imageVersion: '1.2.5-main.9' }).allowed).toBe(false)
    })

    it('refuses a pin that is not a release or a snapshot', () => {
        expect(qadamPinFallback.check({ pinnedVersion: '^1.2.0', imageVersion: '1.2.0' }).allowed).toBe(false)
        expect(qadamPinFallback.check({ pinnedVersion: '1.2.0-beta.1', imageVersion: '1.2.0' }).allowed).toBe(false)
    })
})

// The loader caches a resolved path per alias, so every test uses its own qadam name.
describe('qadamLoader.getQadamPath — a pin neither the store nor the image holds at its own version (#779)', () => {
    const IMAGE_ENTRY_POINT = '/image/@aiqadam/qadam-pin-fallback-image/dist/src/index.js'

    function serveImage({ name, version }: { name: string, version: string | null }): void {
        vi.spyOn(qadamDistIndex, 'get').mockResolvedValue(new Map([[name, { name, version, indexPath: IMAGE_ENTRY_POINT }]]))
    }

    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('runs a stale release pin on the image build inside its caret range, and says so', async () => {
        const name = '@aiqadam/qadam-pin-fallback-in-range'
        serveImage({ name, version: '1.4.2' })

        const resolved = await qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] })
        await qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] })

        expect(resolved).toBe(IMAGE_ENTRY_POINT)
        expect(console.warn).toHaveBeenCalledTimes(1)
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`"qadam":"${name}@1.2.0","imageVersion":"1.4.2"`))
    })

    it('does not remember a fallback answer: a version that appears later is found by the next lookup', async () => {
        const name = '@aiqadam/qadam-pin-fallback-forgotten'
        serveImage({ name, version: '1.4.2' })
        await qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] })

        vi.spyOn(qadamDistIndex, 'get').mockResolvedValue(new Map([[name, { name, version: '1.2.0', indexPath: '/image/exact/dist/src/index.js' }]]))

        expect(await qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] })).toBe('/image/exact/dist/src/index.js')
    })

    it('fails with the pin named when the image build is across the caret', async () => {
        const name = '@aiqadam/qadam-pin-fallback-across'
        serveImage({ name, version: '2.0.0' })

        await expect(qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] }))
            .rejects.toThrow(`${name}@1.2.0`)
        await expect(qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] }))
            .rejects.toThrow('outside ^1.2.0')
    })

    it('fails with the pin named when the image does not ship the qadam', async () => {
        const name = '@aiqadam/qadam-pin-fallback-absent'
        vi.spyOn(qadamDistIndex, 'get').mockResolvedValue(new Map())

        await expect(qadamLoader.getQadamPath({ packageName: `${name}@1.2.0`, devQadams: [] }))
            .rejects.toThrow(`Qadam not found for package: ${name}@1.2.0`)
    })

    it('fails a snapshot pin even when the image ships a build inside its caret range', async () => {
        const name = '@aiqadam/qadam-pin-fallback-snapshot'
        serveImage({ name, version: '1.3.0-main.500' })

        await expect(qadamLoader.getQadamPath({ packageName: `${name}@1.3.0-main.412`, devQadams: [] }))
            .rejects.toThrow('#808')
    })

    it('loads a snapshot pin from the image when the image carries exactly that snapshot', async () => {
        const name = '@aiqadam/qadam-pin-fallback-exact-snapshot'
        serveImage({ name, version: '1.3.0-main.412' })

        expect(await qadamLoader.getQadamPath({ packageName: `${name}@1.3.0-main.412`, devQadams: [] })).toBe(IMAGE_ENTRY_POINT)
        expect(console.warn).not.toHaveBeenCalled()
    })
})
