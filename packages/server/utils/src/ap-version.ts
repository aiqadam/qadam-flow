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
        const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as PackageJson
        cachedCurrentRelease = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
    }
    catch {
        cachedCurrentRelease = '0.0.0'
    }
    return cachedCurrentRelease
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
            const response = await safeHttp.axios.get<PackageJson>(
                'https://raw.githubusercontent.com/activepieces/activepieces/main/package.json',
                {
                    timeout: 5000,
                },
            )
            const version = response.data?.version
            if (typeof version !== 'string') {
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

type PackageJson = {
    version: string
}
