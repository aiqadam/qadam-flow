import fs from 'fs'
import path from 'path'
import { safeHttp } from './safe-http'

let cachedCurrentRelease: string | undefined
let cachedLatestRelease: string | undefined

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

// GitHub tags releases as `v1.2.3`; strip the prefix so comparisons against
// package.json's unprefixed `1.2.3` (via semver) are apples-to-apples.
function parseTagName(tagName: unknown): string | undefined {
    if (typeof tagName !== 'string') {
        return undefined
    }
    const version = tagName.startsWith('v') ? tagName.slice(1) : tagName
    return version.length > 0 ? version : undefined
}

export const apVersionUtil = {
    getCurrentRelease(): string {
        return readCurrentRelease()
    },
    async getLatestRelease(): Promise<string> {
        try {
            if (cachedLatestRelease) {
                return cachedLatestRelease
            }
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
                return '0.0.0'
            }
            cachedLatestRelease = version
            return version
        }
        catch (ex) {
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
