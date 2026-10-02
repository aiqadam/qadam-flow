import path from 'path'

export const staticAssetCache = {
    cacheControlFor({ root, filepath }: { root: string, filepath: string }): string {
        const relativePath = path.relative(root, filepath).split(path.sep).join('/')
        if (relativePath.endsWith('.html')) {
            return NO_CACHE
        }
        if (VITE_HASHED_ASSET.test(relativePath)) {
            return IMMUTABLE
        }
        return REVALIDATE
    },
}

const NO_CACHE = 'no-cache'
const IMMUTABLE = 'public, max-age=31536000, immutable'
const REVALIDATE = 'public, max-age=0, must-revalidate'

// Vite emits every bundled file straight into `assets/` as `[name]-[hash].[ext]`, with an
// 8-character base64url content hash, so a new build always gets a new URL. Files copied from
// `packages/web/public/assets/` keep their own names and sit in subdirectories (`qadams/`,
// `badges/`, `auth/`); they can change in place, so they must revalidate. The single-segment
// requirement matters as much as the hash: names such as `google-calendar.png` have the hash's
// shape and only the subdirectory tells them apart.
const VITE_HASHED_ASSET = /^assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/
