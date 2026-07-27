import fs from 'fs'
import path from 'path'
import semver from 'semver'
import { safeHttp } from './safe-http'

const LATEST_RELEASE_FAILURE_CACHE_TTL_MS = 15 * 60 * 1000

let cachedCurrentRelease: string | undefined
let cachedLatestRelease: string | undefined
let latestReleaseFailureCachedUntil: number | undefined

function readCurrentRelease(): string {
    if (cachedCurrentRelease !== undefined) {
        return cachedCurrentRelease
    }
    try {
        const packageJsonContents: unknown = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'))
        const version = isPackageJson(packageJsonContents) ? packageJsonContents.version : undefined
        cachedCurrentRelease = version ?? '0.0.0'
    }
    catch {
        cachedCurrentRelease = '0.0.0'
    }
    return cachedCurrentRelease
}

function isPackageJson(value: unknown): value is PackageJson {
    return typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'string'
}

// GitHub tags releases as `v1.2.3`; the `v` isn't needed for the semver.gte
// comparison downstream (semver tolerates it on either side), only for the
// unprefixed string operators actually use to `docker pull ...:1.2.3`.
// `release.yml` triggers on any `v*` ref, not just semver ones, so a hand-typed
// tag (a leading-zero typo, a CalVer date, ...) must be rejected here rather
// than forwarded to crash `semver.gte` in the UI. `semver.valid` is the
// authoritative check (a hand-rolled regex approximation previously let
// several of these through) and also strips the `v` prefix as part of parsing.
// Note it also strips build metadata (`1.2.3+build.1` -> `1.2.3`), which is
// harmless for the gte comparison but means a tag with build metadata would no
// longer match a `docker pull ...:<version>` tag verbatim — not a concern for
// this repo's own release process, which doesn't publish build-metadata tags.
function parseTagName(tagName: unknown): string | undefined {
    if (typeof tagName !== 'string') {
        return undefined
    }
    return semver.valid(tagName) ?? undefined
}

function cacheLatestReleaseFailure(): void {
    latestReleaseFailureCachedUntil = Date.now() + LATEST_RELEASE_FAILURE_CACHE_TTL_MS
}

function isLatestReleaseFailureCacheValid(): boolean {
    return latestReleaseFailureCachedUntil !== undefined && Date.now() < latestReleaseFailureCachedUntil
}

export const apVersionUtil = {
    getCurrentRelease(): string {
        return readCurrentRelease()
    },
    async getLatestRelease(): Promise<string> {
        if (cachedLatestRelease) {
            return cachedLatestRelease
        }
        if (isLatestReleaseFailureCacheValid()) {
            return '0.0.0'
        }
        try {
            const response = await safeHttp.axios.get<GitHubRelease>(
                'https://api.github.com/repos/aiqadam/qadam-flow/releases/latest',
                {
                    timeout: 5000,
                    headers: {
                        Accept: 'application/vnd.github+json',
                    },
                },
            )
            const version = parseTagName(response.data?.tag_name)
            if (version === undefined) {
                // No logger is threaded through this util; console is the only sink available (see env-migrations.ts).
                // eslint-disable-next-line no-console
                console.warn(`[ap-version] latest GitHub release tag "${String(response.data?.tag_name)}" is not a parseable version; treating as unknown for ${LATEST_RELEASE_FAILURE_CACHE_TTL_MS / 60_000} minutes`)
                cacheLatestReleaseFailure()
                return '0.0.0'
            }
            cachedLatestRelease = version
            return version
        }
        catch (ex) {
            // No logger is threaded through this util; console is the only sink available (see env-migrations.ts).
            // eslint-disable-next-line no-console
            console.warn(`[ap-version] failed to fetch the latest aiqadam/qadam-flow release; treating as unknown for ${LATEST_RELEASE_FAILURE_CACHE_TTL_MS / 60_000} minutes`, ex)
            cacheLatestReleaseFailure()
            return '0.0.0'
        }
    },
}

type GitHubRelease = {
    tag_name: string
}

type PackageJson = {
    version: string
}
