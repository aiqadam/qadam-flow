import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { sep } from 'path'
import { Qadam, QadamMetadata, qadamTranslation } from '@aiqadam/qadams-framework'
import { extractQadamFromModule } from '@aiqadam/shared'
import clearModule from 'clear-module'
import { FastifyBaseLogger } from 'fastify'
import { AppSystemProp, environmentVariables } from '../../../helper/system/system-props'

const SOURCE_PIECES_PATH = resolve(cwd(), 'packages', 'qadams')

export const fileQadamsUtils = (log: FastifyBaseLogger) => ({

    getPackageNameFromFolderPath: async (folderPath: string): Promise<string> => {
        const packageJson = await readFile(join(folderPath, 'package.json'), 'utf-8').then(JSON.parse)
        return packageJson.name
    },

    getQadamDependencies: async (folderPath: string): Promise<Record<string, string> | null> => {
        try {
            const packageJson =  await readFile(join(folderPath, 'package.json'), 'utf-8').then(JSON.parse)
            if (!packageJson.dependencies) {
                return null
            }
            return packageJson.dependencies
        }
        catch (e) {
            return null
        }
    },

    findDistQadamPathByPackageName: async (packageName: string): Promise<string | null> => {
        const paths = await findAllDistQadamFolders(SOURCE_PIECES_PATH)
        for (const path of paths) {
            try {
                const packageJsonName = await fileQadamsUtils(log).getPackageNameFromFolderPath(path)
                if (packageJsonName === packageName) {
                    return path
                }
            }
            catch (e) {
                log.error({
                    name: 'findDistQadamPathByPackageName',
                    message: JSON.stringify(e),
                }, 'Error finding dist qadam path by package name')
            }
        }
        return null
    },

    findSourceQadamPathByQadamName: async (qadamName: string): Promise<string | null> => {
        const qadamFolders = await findAllQadamFolders(SOURCE_PIECES_PATH)
        const qadamPath = qadamFolders.find((p) => p.endsWith(sep + qadamName))
        return qadamPath ?? null
    },

    loadDistQadamsMetadata: async (qadamNames: string[]): Promise<QadamMetadata[]> => {
        try {
            const devQadams = await findAllDistQadamFolders(SOURCE_PIECES_PATH)
            const paths = devQadams.filter(path => qadamNames.some(name => path.endsWith(sep + name + sep + 'dist')))
            const pieces = await Promise.all(paths.map((p) => loadQadamFromFolder(p)))
            return pieces.filter((p): p is QadamMetadata => p !== null)
        }
        catch (e) {
            const err = e as Error
            log.warn({ err }, '[fileQadamMetadataService#loadDistQadamsMetadata] Failed to load qadams from folder')
            return []
        }
    },

    loadAllDistQadamsMetadata: async (): Promise<QadamMetadata[]> => {
        try {
            const paths = await findAllDistQadamFolders(SOURCE_PIECES_PATH)
            const pieces = await Promise.all(paths.map(async (p) => {
                try {
                    return await loadQadamFromFolder(p)
                }
                catch (err) {
                    log.warn({ err, path: p }, '[fileQadamMetadataService#loadAllDistQadamsMetadata] Skipping qadam that failed to load')
                    return null
                }
            }))
            return pieces.filter((p): p is QadamMetadata => p !== null)
        }
        catch (e) {
            const err = e as Error
            log.warn({ err }, '[fileQadamMetadataService#loadAllDistQadamsMetadata] Failed to load bundled qadams')
            return []
        }
    },


    clearQadamModuleCache: (distFolderPath: string): void => {
        const indexPath = join(distFolderPath, 'src', 'index')
        const packageJsonPath = join(distFolderPath, 'package.json')
        clearModule(indexPath)
        clearModule(packageJsonPath)
    },
})

const findAllQadamFolders = async (folderPath: string): Promise<string[]> => {
    const paths = []
    const files = await readdir(folderPath)

    const ignoredFiles = ['node_modules', 'dist', 'framework', 'common']
    for (const file of files) {
        const filePath = join(folderPath, file)
        const fileStats = await stat(filePath)
        if (
            fileStats.isDirectory() &&
            !ignoredFiles.includes(file)
        ) {
            paths.push(...(await findAllQadamFolders(filePath)))
        }
        else if (file === 'package.json') {
            paths.push(folderPath)
        }
    }
    return paths
}

const findAllDistQadamFolders = async (sourcePiecesPath: string): Promise<string[]> => {
    const sourceFolders = await findAllQadamFolders(sourcePiecesPath)
    const distFolders = []
    for (const folder of sourceFolders) {
        const distPath = join(folder, 'dist')
        try {
            const distStats = await stat(distPath)
            if (distStats.isDirectory()) {
                distFolders.push(distPath)
            }
        }
        catch {
            // dist folder doesn't exist for this qadam, skip
        }
    }
    return distFolders
}

const loadQadamFromFolder = async (
    folderPath: string,
): Promise<QadamMetadata | null> => {
    const indexPath = join(folderPath, 'src', 'index')
    const packageJsonPath = join(folderPath, 'package.json')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const packageJson = require(packageJsonPath)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(indexPath)
    const { name: qadamName, version: qadamVersion } = packageJson
    const piece = extractQadamFromModule<Qadam>({
        module,
        qadamName,
        qadamVersion,
    })
    const originalMetadata = piece.metadata()
    const loadTranslations = environmentVariables.getBooleanEnvironment(AppSystemProp.LOAD_TRANSLATIONS_FOR_DEV_QADAMS)
    const i18n = loadTranslations ? await qadamTranslation.initializeI18n(folderPath) : undefined
    const metadata: QadamMetadata = {
        ...originalMetadata,
        name: qadamName,
        version: qadamVersion,
        authors: piece.authors,
        directoryPath: folderPath,
        i18n,
    }

    return metadata
}