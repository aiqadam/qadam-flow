
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { cwd } from 'node:process'
import * as semver from 'semver'
import { readPackageJson } from './files'
import { StatusCodes } from 'http-status-codes'
import { qadamTranslation, QadamMetadata } from '@aiqadam/qadams-framework'

const LOAD_QADAM_METADATA_CHILD = resolve(
    __dirname,
    '..',
    'qadams',
    'load-qadam-metadata-child.mjs',
)

type LoadedQadamChildPayload = {
    metadata: Omit<QadamMetadata, 'name' | 'version'>;
    minimumSupportedRelease: string | null;
    maximumSupportedRelease: string | null;
    authors: string[];
};

export const AP_CLOUD_API_BASE = 'https://flow.aiqadam.org/api/v1';
export const QADAMS_FOLDER = 'packages/qadams'
export const COMMUNITY_QADAM_FOLDER = 'packages/qadams/community'
export const NON_QADAM_PACKAGES = ['@aiqadam/qadams-framework', '@aiqadam/qadams-common']

const validateSupportedRelease = (minRelease: string | undefined, maxRelease: string | undefined) => {
    if (minRelease !== undefined && !semver.valid(minRelease)) {
        throw Error(`[validateSupportedRelease] "minimumSupportedRelease" should be a valid semver version`)
    }

    if (maxRelease !== undefined && !semver.valid(maxRelease)) {
        throw Error(`[validateSupportedRelease] "maximumSupportedRelease" should be a valid semver version`)
    }

    if (minRelease !== undefined && maxRelease !== undefined && semver.gt(minRelease, maxRelease)) {
        throw Error(`[validateSupportedRelease] "minimumSupportedRelease" should be less than "maximumSupportedRelease"`)
    }
}

const validateMetadata = (qadamMetadata: QadamMetadata): void => {
    console.info(`[validateMetadata] qadamName=${qadamMetadata.name}`)
    validateSupportedRelease(
        qadamMetadata.minimumSupportedRelease,
        qadamMetadata.maximumSupportedRelease,
    )
}


const byDisplayNameIgnoreCase = (a: QadamMetadata, b: QadamMetadata) => {
    const aName = a.displayName.toUpperCase();
    const bName = b.displayName.toUpperCase();
    return aName.localeCompare(bName, 'en');
};

export function getCommunityQadamFolder(qadamName: string): string {
    return join(COMMUNITY_QADAM_FOLDER, qadamName)
}


export async function findAllQadamsDirectoryInSource(): Promise<string[]> {
    const qadamsPath = resolve(cwd(), 'packages', 'qadams')
    const paths = await traverseFolder(qadamsPath)
    return paths.map(p => relative(cwd(), p))
}

export const qadamMetadataExists = async (
    qadamName: string,
    qadamVersion: string
): Promise<boolean> => {
    const cloudResponse = await fetch(
        `${AP_CLOUD_API_BASE}/qadams/${qadamName}?version=${qadamVersion}`
    );

    const qadamExist: Record<number, boolean> = {
        [StatusCodes.OK]: true,
        [StatusCodes.NOT_FOUND]: false
    };

    if (
        qadamExist[cloudResponse.status] === null ||
        qadamExist[cloudResponse.status] === undefined
    ) {
        throw new Error(await cloudResponse.text());
    }

    return qadamExist[cloudResponse.status];
};

export async function findNewQadams(): Promise<QadamMetadata[]> {
    const changedDistPaths = getChangedQadamsDistPaths()
    const paths = changedDistPaths ?? await findAllDistPaths()

    console.info(`[findNewQadams] scanning ${paths.length} dist paths${changedDistPaths ? ' (scoped to changed)' : ' (all)'}`)

    const changedQadams: QadamMetadata[] = []

    const batchSize = 75
    for (let i = 0; i < paths.length; i += batchSize) {
        const batch = paths.slice(i, i + batchSize)
        const batchResults = await Promise.all(batch.map(async (folderPath) => {
            const packageJson = await readPackageJson(folderPath);
            if (NON_QADAM_PACKAGES.includes(packageJson.name)) {
                return null;
            }
            const exists = await qadamMetadataExists(packageJson.name, packageJson.version)
            if (!exists) {
                try {
                    return loadQadamFromFolder(folderPath);
                } catch (ex) {
                    return null;
                }
            }
            return null;
        }))

        const validResults = batchResults.filter((qadam): qadam is QadamMetadata => qadam !== null)
        changedQadams.push(...validResults)
    }

    return changedQadams;
}

function getChangedQadamsDistPaths(): string[] | null {
    const changedQadams = process.env['CHANGED_QADAMS']
    if (!changedQadams || changedQadams.trim() === '') {
        return null
    }
    return changedQadams.split('\n').filter(Boolean).map(p => {
        return resolve(cwd(), p, 'dist')
    }).filter(p => {
        const exists = existsSync(join(p, 'package.json'))
        if (!exists) {
            console.info(`[getChangedQadamsDistPaths] skipping, no build output at ${p}`)
        }
        return exists
    })
}

export async function findAllQadams(): Promise<QadamMetadata[]> {
    const paths = await findAllDistPaths()
    const qadams = await Promise.all(paths.map((p) => loadQadamFromFolder(p)))
    return qadams.filter((p): p is QadamMetadata => p !== null).sort(byDisplayNameIgnoreCase)
}

async function findAllDistPaths(): Promise<string[]> {
    const sourceQadamsPath = resolve(cwd(), 'packages', 'qadams')
    const sourceFolders = await traverseFolder(sourceQadamsPath)
    const distPaths: string[] = []
    for (const folder of sourceFolders) {
        const distPath = join(folder, 'dist')
        const distPackageJson = join(distPath, 'package.json')
        if (existsSync(distPackageJson)) {
            distPaths.push(distPath)
        }
    }
    return distPaths
}

async function traverseFolder(folderPath: string): Promise<string[]> {
    const paths: string[] = []
    const directoryExists = await stat(folderPath).catch(() => null)

    if (directoryExists && directoryExists.isDirectory()) {
        const files = await readdir(folderPath)

        for (const file of files) {
            const filePath = join(folderPath, file)
            const fileStats = await stat(filePath)
            if (fileStats.isDirectory() && file !== 'node_modules' && file !== 'dist') {
                paths.push(...await traverseFolder(filePath))
            }
            else if (file === 'package.json') {
                paths.push(folderPath)
            }
        }
    }
    return paths
}

async function loadQadamFromFolder(folderPath: string): Promise<QadamMetadata | null> {
    try {
        const packageJson = await readPackageJson(folderPath);
        const payload = loadQadamViaChildProcess(folderPath);
        const i18n = await qadamTranslation.initializeI18n(folderPath)
        const metadata: QadamMetadata = {
            ...payload.metadata,
            name: packageJson.name,
            version: packageJson.version,
            i18n,
            authors: payload.authors,
            directoryPath: folderPath,
            minimumSupportedRelease: payload.minimumSupportedRelease ?? '0.0.0',
            maximumSupportedRelease: payload.maximumSupportedRelease ?? '99999.99999.9999',
        };

        validateMetadata(metadata);
        return metadata;
    }
    catch (ex) {
        console.error(ex)
    }
    return null
}

function loadQadamViaChildProcess(folderPath: string): LoadedQadamChildPayload {
    const stdout = execFileSync('node', [LOAD_QADAM_METADATA_CHILD, folderPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
        maxBuffer: 64 * 1024 * 1024,
    })
    return JSON.parse(stdout) as LoadedQadamChildPayload
}

