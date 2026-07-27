import fs from 'fs'
import path from 'path'
import { safeHttp } from './safe-http'

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/
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
// unprefixed string operators actually use to `docker pull ...:1.2.3`. A tag
// can be any ref matching `v*` (release.yml doesn't restrict it to semver), so
// this also rejects anything that isn't parseable as a version rather than
// forwarding a string that would later crash `semver.gte` in the UI.
function parseTagName(tagName: unknown): string | undefined {
    if (typeof tagName !== 'string') {
        return undefined
    }
    const version = tagName.startsWith('v') ? tagName.slice(1) : tagName
    return SEMVER_PATTERN.test(version) ? version : undefined
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
