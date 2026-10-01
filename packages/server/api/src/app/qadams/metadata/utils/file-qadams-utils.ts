import { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { cwd } from 'node:process'
import { sep } from 'path'
import { Qadam, QadamMetadata, qadamTranslation } from '@aiqadam/qadams-framework'
import { extractQadamFromModule, tryCatch } from '@aiqadam/shared'
import clearModule from 'clear-module'
import { FastifyBaseLogger } from 'fastify'
import { AppSystemProp, environmentVariables } from '../../../helper/system/system-props'

export const fileQadamsUtils = (log: FastifyBaseLogger) => ({

    // Resolved per call rather than once at import, so a caller (or a test) that runs from a
    // different working directory reads the tree it is standing in.
    bundledQadamsRoot: (): string => resolve(cwd(), 'packages', 'qadams'),

    // The scan's own walk, with no `require`: every `<qadam>/dist` folder under the root, in scan order.
    findDistQadamFolders: async ({ qadamsRoot }: { qadamsRoot: string }): Promise<string[]> => findAllDistQadamFolders(qadamsRoot),

    // `AP_LOAD_TRANSLATIONS_FOR_DEV_QADAMS`, which despite its name governs every bundled qadam's `i18n`.
    isTranslationLoadingEnabled: (): boolean => isTranslationLoadingEnabled(),

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
        const paths = await findAllDistQadamFolders(fileQadamsUtils(log).bundledQadamsRoot())
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
        const qadamFolders = await findAllQadamFolders(fileQadamsUtils(log).bundledQadamsRoot())
        const qadamPath = qadamFolders.find((p) => p.endsWith(sep + qadamName))
        return qadamPath ?? null
    },

    loadDistQadamsMetadata: async (qadamNames: string[]): Promise<QadamMetadata[]> => {
        try {
            const devQadams = await findAllDistQadamFolders(fileQadamsUtils(log).bundledQadamsRoot())
            const paths = devQadams.filter(path => qadamNames.some(name => path.endsWith(sep + name + sep + 'dist')))
            const loadTranslations = isTranslationLoadingEnabled()
            const pieces = await Promise.all(paths.map((p) => loadQadamFromFolder({ folderPath: p, loadTranslations })))
            return pieces.filter((p): p is QadamMetadata => p !== null)
        }
        catch (e) {
            const err = e as Error
            log.warn({ err }, '[fileQadamMetadataService#loadDistQadamsMetadata] Failed to load qadams from folder')
            return []
        }
    },

    // Synchronous `require` of every bundled qadam: tens of seconds on the event loop for the full
    // catalogue (#598). The app reaches it only when the image-build manifest is missing or rejected
    // (`bundledQadamsManifest`); the manifest writer is the other caller, at image-build time.
    loadAllDistQadamsMetadata: async ({ qadamsRoot, loadTranslations }: LoadAllDistQadamsMetadataParams): Promise<QadamMetadata[]> => {
        try {
            const paths = await findAllDistQadamFolders(qadamsRoot)
            const pieces = await Promise.all(paths.map(async (p) => {
                try {
                    return await loadQadamFromFolder({ folderPath: p, loadTranslations })
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

const IGNORED_FOLDERS = ['node_modules', 'dist', 'framework', 'common']

// Concurrent rather than one `stat` at a time: the manifest read walks this tree too, to check that
// every built dist has an entry (#598), and the sequential walk took ~400 ms. The result keeps the
// sequential walk's order: each entry's paths are flattened in `readdir` order.
const findAllQadamFolders = async (folderPath: string): Promise<string[]> => {
    const entries = await readdir(folderPath, { withFileTypes: true })
    const pathsPerEntry = await Promise.all(entries.map(async (entry): Promise<string[]> => {
        const filePath = join(folderPath, entry.name)
        if (await isDirectory({ entry, filePath }) && !IGNORED_FOLDERS.includes(entry.name)) {
            return findAllQadamFolders(filePath)
        }
        return entry.name === 'package.json' ? [folderPath] : []
    }))
    return pathsPerEntry.flat()
}

// A symlink is followed, as the `stat` this replaced did.
const isDirectory = async ({ entry, filePath }: { entry: Dirent, filePath: string }): Promise<boolean> => {
    return entry.isSymbolicLink() ? (await stat(filePath)).isDirectory() : entry.isDirectory()
}

const findAllDistQadamFolders = async (sourcePiecesPath: string): Promise<string[]> => {
    const sourceFolders = await findAllQadamFolders(sourcePiecesPath)
    const distFolders = await Promise.all(sourceFolders.map(async (folder): Promise<string | null> => {
        const distPath = join(folder, 'dist')
        const { data: distStats } = await tryCatch(() => stat(distPath))
        return distStats?.isDirectory() ? distPath : null
    }))
    return distFolders.filter((distPath): distPath is string => distPath !== null)
}

const isTranslationLoadingEnabled = (): boolean => {
    return environmentVariables.getBooleanEnvironment(AppSystemProp.LOAD_TRANSLATIONS_FOR_DEV_QADAMS) ?? false
}

const loadQadamFromFolder = async ({ folderPath, loadTranslations }: LoadQadamFromFolderParams): Promise<QadamMetadata | null> => {
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

type LoadAllDistQadamsMetadataParams = {
    qadamsRoot: string
    loadTranslations: boolean
}

type LoadQadamFromFolderParams = {
    folderPath: string
    loadTranslations: boolean
}
