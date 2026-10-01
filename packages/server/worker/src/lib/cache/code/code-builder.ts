import { randomUUID } from 'node:crypto'
import fs, { rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { cryptoUtils, fileSystemUtils } from '@aiqadam/server-utils'
import { ExecutionMode, FlowVersionState, isNil, SourceCode, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { trace } from '@opentelemetry/api'
import { Logger } from 'pino'
import { workerSettings } from '../../config/worker-settings'
import { cacheState, NO_SAVE_GUARD } from '../cache-state'
import { bunRunner } from './bun-runner'

const tracer = trace.getTracer('code-builder')

const BUILD_DIR_MARKER = '.build-'
const RETIRED_DIR_MARKER = '.retired-'
// Above the longest a build can legitimately run: bunRunner's timeouts are 10 min for
// `bun install` and 5 min for esbuild.
const ORPHANED_BUILD_MIN_AGE_MS = 20 * 60 * 1000
// Records which source a step directory was built from, so a replica that finds another
// replica's build in place can tell a build of the same source from a stale one.
const SOURCE_HASH_FILE = '.source-hash'
const MAX_SWAP_ATTEMPTS = 3
const CREATED_AT_PATTERN = new RegExp(`(?:\\${BUILD_DIR_MARKER}|\\${RETIRED_DIR_MARKER})(\\d+)-`)

const TS_CONFIG_CONTENT = `
{
    "compilerOptions": {
        "lib": ["es2022", "dom"],
        "module": "commonjs",
        "target": "es2022",
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "noUnusedLocals": false,
        "noUnusedParameters": false,
        "strict": false,
        "strictPropertyInitialization": false,
        "strictNullChecks": false,
        "strictFunctionTypes": false,
        "strictBindCallApply": false,
        "noImplicitAny": false,
        "noImplicitThis": false,
        "noImplicitReturns": false,
        "noFallthroughCasesInSwitch": false
    }
}
`

const INVALID_ARTIFACT_TEMPLATE = `
    exports.code = async (params) => {
      throw new Error(\`\${ERROR_MESSAGE}\`);
    };
    `

const INVALID_ARTIFACT_ERROR_PLACEHOLDER = '${ERROR_MESSAGE}'

export const codeBuilder = (log: Logger) => ({
    getCodesFolder({
        codesFolderPath,
        flowVersionId,
    }: {
        codesFolderPath: string
        flowVersionId: string
    }): string {
        return path.join(codesFolderPath, flowVersionId)
    },

    async processCodeStep({
        artifact,
        codesFolderPath,
    }: ProcessCodeStepParams): Promise<void> {
        const { sourceCode, flowVersionId, name } = artifact
        const flowVersionPath = path.join(codesFolderPath, flowVersionId)
        const codePath = path.join(flowVersionPath, name)
        log.debug({ sourceCode, name, codePath }, 'Processing code step')

        const currentHash = await cryptoUtils.hashObject(sourceCode)
        const cache = cacheState(codePath)
        await cache.getOrSetCache({
            key: codePath,
            cacheMiss: async (value: string) => {
                if (value !== currentHash) {
                    return true
                }
                // cache.json lives inside the step directory, and after a lock-timeout fallback a
                // replica that lost the swap can still save its own hash into the winner's build,
                // so the hash the build itself carries is the authority (#586).
                const builtFrom = await readSourceHash(codePath)
                if (!isNil(builtFrom)) {
                    return builtFrom !== currentHash
                }
                // No hash and no directory: the build is gone, e.g. another replica is between its
                // two renames, so this is a miss that waits on the lock and reads again. No hash in
                // a directory that exists: a build from before #586, and for it cache.json is all
                // there is.
                if (!(await fileSystemUtils.fileExists(codePath))) {
                    return true
                }
                // The directory can have been swapped in between the two reads, so it is read once
                // more before being taken for one without a hash.
                const builtFromOnRecheck = await readSourceHash(codePath)
                return !isNil(builtFromOnRecheck) && builtFromOnRecheck !== currentHash
            },
            installFn: async () => {
                await removeOrphanedBuilds({ codePath, log })
                // Built beside the live directory and swapped in only once complete, instead of
                // `rm -rf` + an in-place rebuild: a reader must never find a half-built step (#586).
                const buildPath = siblingPath({ target: codePath, marker: BUILD_DIR_MARKER })
                const { error } = await tryCatch(async () => {
                    await buildCodeStep({ buildPath, codePath, sourceCode, log })
                    await fs.writeFile(path.join(buildPath, SOURCE_HASH_FILE), currentHash)
                    await replaceDirectory({ from: buildPath, to: codePath, sourceHash: currentHash, log })
                })
                if (error) {
                    await removeBestEffort({ target: buildPath, log })
                    throw error
                }
                return currentHash
            },
            skipSave: NO_SAVE_GUARD,
            crossProcess: { log },
        })
    },
})

async function buildCodeStep({ buildPath, codePath, sourceCode, log }: BuildCodeStepParams): Promise<void> {
    const { code, packageJson } = sourceCode
    await fileSystemUtils.threadSafeMkdir(buildPath)

    await tracer.startActiveSpan('codeBuilder.installDependencies', async (depSpan) => {
        try {
            depSpan.setAttribute('code.path', codePath)
            await installDependencies({
                path: buildPath,
                packageJson: getPackageJson(packageJson),
            }, log)
            log.info({ path: codePath }, 'Installed dependencies')
        }
        finally {
            depSpan.end()
        }
    })

    await tracer.startActiveSpan('codeBuilder.compileCode', async (compileSpan) => {
        try {
            compileSpan.setAttribute('code.path', codePath)
            const { error } = await tryCatch(() => compileCode({
                path: buildPath,
                code,
            }, log))
            if (error) {
                log.info({ codePath, error }, 'Compilation error')
                compileSpan.recordException(error instanceof Error ? error : new Error(String(error)))
                await handleCompilationError({ buildPath, codePath, error })
            }
            else {
                log.info({ codePath }, 'Compilation success')
            }
        }
        finally {
            compileSpan.end()
        }
    })

    // node_modules is no longer needed after esbuild bundles everything into index.js
    await tryCatch(() => rm(path.join(buildPath, 'node_modules'), { recursive: true }))
}

// rename(2) cannot replace a non-empty directory, so the live build is moved aside first. The
// step path is missing only between the two renames, not for the length of a build.
async function replaceDirectory({ from, to, sourceHash, log }: ReplaceDirectoryParams): Promise<void> {
    for (let attempt = 1; attempt <= MAX_SWAP_ATTEMPTS; attempt++) {
        const swapped = await swapDirectory({ from, to, log })
        if (swapped) {
            return
        }
        // Reachable only after the cross-container lock timed out (see cacheState): another replica
        // swapped its own build of this step in between our two renames. Theirs is kept only if it
        // was built from the same source; otherwise the next attempt retires it for ours.
        if (await readSourceHash(to) === sourceHash) {
            await removeBestEffort({ target: from, log })
            return
        }
    }
    throw new Error(`Could not swap the build of ${to} in: other replicas kept replacing it`)
}

// Resolves false, with the live build left as another replica put it, when the target was taken
// between the two renames.
async function swapDirectory({ from, to, log }: SwapDirectoryParams): Promise<boolean> {
    const retiredPath = siblingPath({ target: to, marker: RETIRED_DIR_MARKER })
    const { error: retireError } = await tryCatch(() => rename(to, retiredPath))
    if (!isNil(retireError) && !fileSystemUtils.hasErrorCode({ error: retireError, code: 'ENOENT' })) {
        throw retireError
    }
    const retiredLiveBuild = isNil(retireError)
    const { error: swapError } = await tryCatch(() => rename(from, to))
    if (isNil(swapError) || isTargetTaken(swapError)) {
        if (retiredLiveBuild) {
            await removeBestEffort({ target: retiredPath, log })
        }
        return isNil(swapError)
    }
    if (retiredLiveBuild) {
        const { error: restoreError } = await tryCatch(() => rename(retiredPath, to))
        if (!isNil(restoreError)) {
            log.error({ codePath: to, retiredPath, error: restoreError }, '[codeBuilder] Could not restore the previous build after a failed swap')
        }
    }
    throw swapError
}

function isTargetTaken(error: unknown): boolean {
    return fileSystemUtils.hasErrorCode({ error, code: 'ENOTEMPTY' }) || fileSystemUtils.hasErrorCode({ error, code: 'EEXIST' })
}

// A worker killed mid-build or mid-swap leaves its build or retired directory behind on the
// shared volume. Only ones older than any build can run are removed: a younger one may be
// another replica's build in progress, which the lock cannot rule out once it has timed out.
async function removeOrphanedBuilds({ codePath, log }: RemoveOrphanedBuildsParams): Promise<void> {
    const parentPath = path.dirname(codePath)
    const stepName = path.basename(codePath)
    const { data: entries } = await tryCatch(() => fs.readdir(parentPath))
    if (isNil(entries)) {
        return
    }
    const candidates = entries.filter((entry) =>
        entry.startsWith(`${stepName}${BUILD_DIR_MARKER}`) || entry.startsWith(`${stepName}${RETIRED_DIR_MARKER}`))
    await Promise.all(candidates.map(async (entry) => {
        const target = path.join(parentPath, entry)
        const createdAt = await readCreatedAt({ target, entry })
        if (isNil(createdAt) || Date.now() - createdAt < ORPHANED_BUILD_MIN_AGE_MS) {
            return
        }
        await removeBestEffort({ target, log })
    }))
}

// The creation time is carried in the name because a directory's own mtime cannot age it:
// rename(2) leaves the moved directory's mtime alone, so a live build retired a moment ago
// would still carry the time it was built.
function siblingPath({ target, marker }: SiblingPathParams): string {
    return `${target}${marker}${Date.now()}-${randomUUID()}`
}

async function readCreatedAt({ target, entry }: ReadCreatedAtParams): Promise<number | null> {
    const match = CREATED_AT_PATTERN.exec(entry)
    if (!isNil(match)) {
        return Number(match[1])
    }
    const { data: stats } = await tryCatch(() => fs.stat(target))
    return isNil(stats) ? null : stats.ctimeMs
}

async function readSourceHash(codePath: string): Promise<string | null> {
    const { data } = await tryCatch(() => fs.readFile(path.join(codePath, SOURCE_HASH_FILE), 'utf8'))
    return data ?? null
}

// The build is already in place by the time a leftover is removed; failing the job over a
// directory that could not be deleted would throw away a good build.
async function removeBestEffort({ target, log }: RemoveBestEffortParams): Promise<void> {
    const { error } = await tryCatch(() => rm(target, { recursive: true, force: true }))
    if (!isNil(error)) {
        log.warn({ target, error }, '[codeBuilder] Could not remove a leftover build directory')
    }
}

function isPackagesAllowed(): boolean {
    switch (workerSettings.getSettings().EXECUTION_MODE) {
        case ExecutionMode.SANDBOX_CODE_ONLY:
            return false
        case ExecutionMode.SANDBOX_CODE_AND_PROCESS:
        case ExecutionMode.UNSANDBOXED:
        case ExecutionMode.SANDBOX_PROCESS:
            return true
        default:
            return false
    }
}

function getPackageJson(packageJson: string): string {
    const packagedAllowed = isPackagesAllowed()
    if (!packagedAllowed) {
        return '{"dependencies":{}}'
    }
    const { data: parsedPackageJson, error: parseError } = tryCatchSync(() => JSON.parse(packageJson))
    const packageJsonObject = parseError ? {} : (parsedPackageJson as Record<string, unknown>)
    return JSON.stringify({
        ...packageJsonObject,
        dependencies: {
            '@types/node': '18.17.1',
            ...(packageJsonObject?.['dependencies'] ?? {}),
        },
    })
}

async function installDependencies({ path, packageJson }: InstallDependenciesParams, log: Logger): Promise<void> {
    await fs.writeFile(`${path}/package.json`, packageJson, 'utf8')
    const deps = Object.entries(JSON.parse(packageJson).dependencies ?? {})
    if (deps.length > 0) {
        await bunRunner(log).install({ path, filtersPath: [] })
    }
}

async function compileCode({ path, code }: CompileCodeParams, log: Logger): Promise<void> {
    await fs.writeFile(`${path}/tsconfig.json`, TS_CONFIG_CONTENT, {
        encoding: 'utf8',
        flag: 'w',
    })
    await fs.writeFile(`${path}/index.ts`, code, { encoding: 'utf8', flag: 'w' })

    await bunRunner(log).build({
        path,
        entryFile: `${path}/index.ts`,
        outputFile: `${path}/index.js`,
    })
}

async function handleCompilationError({ buildPath, codePath, error }: HandleCompilationErrorParams): Promise<void> {
    const errorHasStdout =
        typeof error === 'object' && error && 'stdout' in error
    const stdoutError = errorHasStdout ? error.stdout : undefined
    const genericError = `${error ?? 'error compiling'}`
    // The step's user sees this message; the build directory's name is an internal detail.
    const errorMessage = `Compilation Error ${stdoutError ?? genericError}`.replaceAll(buildPath, codePath)

    const invalidArtifactContent = INVALID_ARTIFACT_TEMPLATE.replace(
        INVALID_ARTIFACT_ERROR_PLACEHOLDER,
        errorMessage,
    )

    await fs.writeFile(`${buildPath}/index.js`, invalidArtifactContent, 'utf8')
}

type ProcessCodeStepParams = {
    artifact: CodeArtifact
    codesFolderPath: string
}

export type CodeArtifact = {
    name: string
    sourceCode: SourceCode
    flowVersionId: string
    flowVersionState: FlowVersionState
}

type BuildCodeStepParams = {
    buildPath: string
    codePath: string
    sourceCode: SourceCode
    log: Logger
}

type ReplaceDirectoryParams = {
    from: string
    to: string
    sourceHash: string
    log: Logger
}

type SwapDirectoryParams = {
    from: string
    to: string
    log: Logger
}

type SiblingPathParams = {
    target: string
    marker: string
}

type ReadCreatedAtParams = {
    target: string
    entry: string
}

type RemoveOrphanedBuildsParams = {
    codePath: string
    log: Logger
}

type RemoveBestEffortParams = {
    target: string
    log: Logger
}

type InstallDependenciesParams = {
    path: string
    packageJson: string
}

type CompileCodeParams = {
    path: string
    code: string
}

type HandleCompilationErrorParams = {
    buildPath: string
    codePath: string
    error: unknown
}
