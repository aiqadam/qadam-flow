import path from 'path'
import { staticAssetCache } from '../../../../src/app/helper/static-asset-cache'

const ROOT = path.resolve('/srv/app/dist/packages/web')
const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'public, max-age=0, must-revalidate'

function cacheControlFor(relativePath: string): string {
    return staticAssetCache.cacheControlFor({ root: ROOT, filepath: path.join(ROOT, relativePath) })
}

describe('staticAssetCache.cacheControlFor', () => {
    it.each([
        'assets/index-PTXJdy6q.js',
        'assets/cpp-CofmeUqb.js',
        'assets/index-B_x-1a2c.css',
        'assets/inter-latin-500-AbCdEf12.woff2',
    ])('marks the Vite-hashed bundle file %s immutable', (relativePath) => {
        expect(cacheControlFor(relativePath)).toBe(IMMUTABLE)
    })

    it.each([
        'assets/qadams/google-calendar.png',
        'assets/qadams/microsoft-power-bi.png',
        'assets/badges/first-flow.svg',
        'assets/auth/background.webp',
    ])('makes the unhashed public asset %s revalidate, even when its name has the hash shape', (relativePath) => {
        expect(cacheControlFor(relativePath)).toBe(REVALIDATE)
    })

    it.each([
        'assets/logo.svg',
        'favicon.ico',
        'logo-flow.svg',
        'locales/en/translation.json',
    ])('makes the unhashed file %s revalidate', (relativePath) => {
        expect(cacheControlFor(relativePath)).toBe(REVALIDATE)
    })

    it('never caches the SPA entry point', () => {
        expect(cacheControlFor('index.html')).toBe('no-cache')
    })

    it('judges the path relative to the root, not a root that itself contains /assets/', () => {
        const root = path.resolve('/srv/assets/web')

        expect(staticAssetCache.cacheControlFor({ root, filepath: path.join(root, 'favicon.ico') })).toBe(REVALIDATE)
    })
})
