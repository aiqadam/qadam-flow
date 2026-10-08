// Builds one qadam version as the ADR-0003 artifact (#804).
//
// Layout of `<outRoot>/<name>/<version>/` — deliberately the same shape as today's `dist/`, so the
// API's metadata scan (`loadQadamFromFolder`: `package.json` + `src/index` + `src/i18n`) and the
// engine's loader read it without a new code path:
//
//   package.json        name, version, `main: ./src/index.js`, `peerDependencies` on the
//                       `@aiqadam/*` packages and `zod` the bundle imports (#772 option B), and
//                       `qadamArtifact: { formatVersion, kind }` so a loader can tell this format
//                       from a legacy `0.x` npm package
//   src/index.js        the bundle: the qadam's own code and its third-party dependencies
//   src/<worker>.js     extra entry points a qadam starts from `__dirname` (worker / forked runner)
//   src/i18n/*.json     the qadam's translations (#606 must not repeat here)
//   metadata.json       the metadata the catalogue (#778) publishes, extracted from this artifact
//   node_modules/       only for kind `bundle-with-node-modules`: the declared native packages
//                       and their dependency closure, listed in `dependencies` and
//                       `bundleDependencies` so `npm pack` carries them
//
// `@aiqadam/*` and `zod` are never inside the artifact: the platform provides one copy (ADR-0003).
// The artifact resolves them the way Node always does, upward from its own directory — so a store
// at `<volume>/qadams/<name>/<version>/` with the platform's copies in `<volume>/qadams/node_modules`
// serves the bundle, its worker threads and its forked children alike.

import { execFile } from 'node:child_process'
import { cp, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

export const ARTIFACT_FORMAT_VERSION = 1

export const ARTIFACT_KIND = {
    BUNDLE: 'bundle',
    BUNDLE_WITH_NODE_MODULES: 'bundle-with-node-modules',
}

export const ARTIFACT_STATUS = {
    OK: 'ok',
    BUNDLE_FAILED: 'bundle-failed',
    PEER_INLINED: 'peer-inlined',
    UNKNOWN_PEER: 'unknown-peer',
    NATIVE_UNDECLARED: 'native-undeclared',
    RUNTIME_FILE_UNDECLARED: 'runtime-file-undeclared',
    LOAD_FAILED: 'load-failed',
    PACK_FAILED: 'pack-failed',
    BUILD_ERROR: 'build-error',
}

// The packages the platform provides. A bundle that inlined any of them would carry its own copy,
// which is the cost ADR-0003 exists to remove (~41 MiB of heap per extra `shared`).
export const PLATFORM_PROVIDED_PACKAGES = {
    '@aiqadam/shared': 'packages/shared',
    '@aiqadam/qadams-framework': 'packages/qadams/framework',
    '@aiqadam/qadams-common': 'packages/qadams/common',
}

export const qadamArtifact = {
    build: async ({ qadamDir, outRoot, repoRoot, config, loadCheck, pack, packDestination }) => {
        const startedAt = Date.now()
        const sourcePackageJson = JSON.parse(await readFile(join(qadamDir, 'package.json'), 'utf8'))
        const { name, version } = sourcePackageJson
        const qadamConfig = normalizeQadamConfig({ raw: config.qadams?.[name] })
        const artifactDir = join(outRoot, name, version)
        const base = {
            name,
            version,
            source: relative(repoRoot, qadamDir),
            artifactDir: relative(outRoot, artifactDir),
        }
        const finish = (fields) => ({ ...base, ...fields, durationMs: Date.now() - startedAt })
        // A store must never hold a half-built version, so anything short of OK leaves no directory.
        const fail = async (fields) => {
            await rm(artifactDir, { recursive: true, force: true })
            return finish(fields)
        }

        await rm(artifactDir, { recursive: true, force: true })
        await mkdir(join(artifactDir, 'src'), { recursive: true })

        const bundleOutcome = await runEsbuild({
            qadamDir,
            artifactDir,
            nodeModulesPackages: qadamConfig.nodeModules,
            extraEntryPoints: qadamConfig.extraEntryPoints,
        })
        if (bundleOutcome.error) {
            return fail({ status: ARTIFACT_STATUS.BUNDLE_FAILED, error: bundleOutcome.error })
        }
        const analysis = await analyseMetafile({
            metafile: bundleOutcome.metafile,
            qadamDir,
            repoRoot,
            nativeAddonImports: bundleOutcome.nativeAddonImports,
            qadamConfig,
        })
        const kind = qadamConfig.nodeModules.length > 0 ? ARTIFACT_KIND.BUNDLE_WITH_NODE_MODULES : ARTIFACT_KIND.BUNDLE
        const sizes = { bundleBytes: (await stat(join(artifactDir, 'src', 'index.js'))).size }
        const common = { kind, sizes, ...analysis.report, esbuildWarnings: bundleOutcome.warnings }

        if (analysis.inlinedPeers.length > 0) {
            return fail({ ...common, status: ARTIFACT_STATUS.PEER_INLINED, error: `bundle contains platform-provided code: ${analysis.inlinedPeers.join(', ')}` })
        }
        const unknownPeers = analysis.peers.filter((peer) => peer !== 'zod' && PLATFORM_PROVIDED_PACKAGES[peer] === undefined)
        if (unknownPeers.length > 0) {
            return fail({ ...common, status: ARTIFACT_STATUS.UNKNOWN_PEER, error: `imports @aiqadam packages the platform does not provide: ${unknownPeers.join(', ')}` })
        }
        if (analysis.undeclaredNative.length > 0) {
            return fail({ ...common, status: ARTIFACT_STATUS.NATIVE_UNDECLARED, error: `native addon packages need a declared exception (nodeModules or optionalNative): ${analysis.undeclaredNative.join(', ')}` })
        }

        // The qadam's own code locating a file beside itself (a worker, a forked runner) needs that
        // file emitted next to the bundle; without a declared entry the bundle loads and the action
        // fails when it runs, which no load check sees.
        if (analysis.ownRuntimeFileReferences.length > 0 && qadamConfig.extraEntryPoints.length === 0) {
            return fail({ ...common, status: ARTIFACT_STATUS.RUNTIME_FILE_UNDECLARED, error: `own source locates files from its own path, declare extraEntryPoints: ${analysis.ownRuntimeFileReferences.join(', ')}` })
        }

        const i18nLocales = await copyI18n({ qadamDir, artifactDir })
        const nodeModules = kind === ARTIFACT_KIND.BUNDLE_WITH_NODE_MODULES
            ? await copyNodeModulesClosure({ roots: qadamConfig.nodeModules, fromDir: qadamDir, artifactDir })
            : {}
        const peerDependencies = await computePeerDependencies({ peers: analysis.peers, repoRoot })
        await writeFile(join(artifactDir, 'package.json'), JSON.stringify(buildArtifactPackageJson({
            sourcePackageJson,
            kind,
            peerDependencies,
            nodeModules,
        }), null, 2) + '\n')

        const withFiles = { ...common, i18nLocales, peerDependencies, nodeModules: Object.keys(nodeModules).length }
        if (!loadCheck) {
            return finish({ ...withFiles, status: ARTIFACT_STATUS.OK, metadata: null })
        }
        const loaded = await extractMetadata({ artifactDir })
        if (loaded.error) {
            return fail({ ...withFiles, status: ARTIFACT_STATUS.LOAD_FAILED, error: loaded.error })
        }
        const artifactBytes = await directorySize({ dir: artifactDir })
        const loadedFields = { ...withFiles, sizes: { ...sizes, artifactBytes }, metadata: loaded.summary }
        if (!pack) {
            return finish({ ...loadedFields, status: ARTIFACT_STATUS.OK })
        }
        const packed = await packArtifact({ artifactDir, packDestination })
        if (packed.error) {
            return fail({ ...loadedFields, status: ARTIFACT_STATUS.PACK_FAILED, error: packed.error })
        }
        return finish({ ...loadedFields, status: ARTIFACT_STATUS.OK, tarball: packed.tarball })
    },

    // The platform's copies, where a store would keep them: `<outRoot>/node_modules`. Only the load
    // check uses it; nothing here is part of an artifact.
    provisionHost: async ({ outRoot, repoRoot }) => {
        const hostModules = join(outRoot, 'node_modules')
        const links = await Promise.all(Object.entries(PLATFORM_PROVIDED_PACKAGES).map(async ([packageName, packagePath]) => {
            const target = join(repoRoot, packagePath)
            const entry = JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).main
            await stat(join(target, entry)).catch(() => {
                throw new Error(`${packageName} is not built (${packagePath}/${entry} missing): run \`npx turbo run build --filter='@aiqadam/qadams-common...'\` first`)
            })
            return { packageName, target }
        }))
        const zodDir = await findPackageDir({ packageName: 'zod', fromDir: join(repoRoot, PLATFORM_PROVIDED_PACKAGES['@aiqadam/qadams-framework']) })
        const all = [...links, { packageName: 'zod', target: zodDir }]
        await rm(hostModules, { recursive: true, force: true })
        await mkdir(join(hostModules, '@aiqadam'), { recursive: true })
        await Promise.all(all.map(({ packageName, target }) => symlinkDir({ target, path: join(hostModules, packageName) })))
        return Object.fromEntries(all.map(({ packageName, target }) => [packageName, target]))
    },
}

const execFileAsync = promisify(execFile)

const PEER_PACKAGE_PATTERN = /^(@aiqadam\/[^/]+|zod)(\/.*)?$/

// Packages whose presence in a dependency's manifest means it loads a compiled addon at run time.
const NATIVE_LOADER_PACKAGES = ['node-gyp-build', 'bindings', 'prebuild-install', '@mapbox/node-pre-gyp', 'node-pre-gyp', 'node-addon-api', 'nan', 'cmake-js']

const IMPORT_META_URL_SHIM = '__qadamArtifactImportMetaUrl'

const nativeAddonScanCache = new Map()

const runEsbuild = async ({ qadamDir, artifactDir, nodeModulesPackages, extraEntryPoints }) => {
    const nativeAddonImports = []
    const tsconfigRaw = readEmitOptions({ qadamDir })
    const entryPoints = [
        { in: join(qadamDir, 'src', 'index.ts'), out: 'index' },
        ...extraEntryPoints.map((entry) => ({ in: join(qadamDir, entry), out: basename(entry, extname(entry)) })),
    ]
    try {
        const result = await build({
            entryPoints,
            outdir: join(artifactDir, 'src'),
            absWorkingDir: qadamDir,
            tsconfigRaw,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node22',
            external: ['@aiqadam/*', 'zod', 'zod/*', ...nodeModulesPackages.flatMap((pkg) => [pkg, `${pkg}/*`])],
            // A CJS bundle has no `import.meta`; esbuild would replace it with `{}` and a dependency
            // calling `fileURLToPath(import.meta.url)` throws on load. That is how the prototype's
            // `crypto` bundle failed (ADR-0003 Evidence).
            define: {
                'import.meta.url': IMPORT_META_URL_SHIM,
                'import.meta.dirname': '__dirname',
                'import.meta.filename': '__filename',
            },
            banner: { js: `var ${IMPORT_META_URL_SHIM} = require('url').pathToFileURL(__filename).href;` },
            legalComments: 'linked',
            keepNames: true,
            metafile: true,
            logLevel: 'silent',
            plugins: [nativeAddonPlugin({ onNativeAddonImport: (entry) => nativeAddonImports.push(entry) })],
        })
        return { metafile: result.metafile, warnings: result.warnings.map(formatMessage), nativeAddonImports }
    }
    catch (e) {
        const messages = Array.isArray(e?.errors) && e.errors.length > 0
            ? e.errors.slice(0, 5).map(formatMessage)
            : [String(e?.message ?? e)]
        return { error: messages.join(' | ') }
    }
}

// Only the options that change emitted semantics, taken from the qadam's effective tsconfig. Not
// the file itself: its `paths` / `baseUrl` would steer esbuild's resolution, while tsc leaves
// specifiers untouched and Node resolves them at run time — `qadam-ai` maps two subpaths to
// `.d.cts` type files that way, which esbuild would try to bundle.
const readEmitOptions = ({ qadamDir }) => {
    const ts = createRequire(join(qadamDir, 'package.json'))('typescript')
    const configPath = join(qadamDir, 'tsconfig.lib.json')
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
    if (error) {
        throw new Error(`cannot read ${configPath}: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`)
    }
    const { options } = ts.parseJsonConfigFileContent(config, ts.sys, qadamDir, undefined, configPath)
    const compilerOptions = {
        experimentalDecorators: options.experimentalDecorators,
        useDefineForClassFields: options.useDefineForClassFields,
        verbatimModuleSyntax: options.verbatimModuleSyntax,
        alwaysStrict: options.alwaysStrict,
        target: options.target === undefined ? undefined : scriptTargetName({ ts, target: options.target }),
    }
    return { compilerOptions: Object.fromEntries(Object.entries(compilerOptions).filter(([, value]) => value !== undefined)) }
}

// `ScriptTarget` maps 99 back to `Latest`, an alias esbuild does not accept.
const scriptTargetName = ({ ts, target }) => (target === ts.ScriptTarget.ESNext ? 'esnext' : ts.ScriptTarget[target].toLowerCase())

// A `.node` file cannot be bundled. Leaving it external lets the build finish so the importing
// package is reported by name instead of as an opaque resolve error.
const nativeAddonPlugin = ({ onNativeAddonImport }) => ({
    name: 'qadam-native-addon',
    setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /\.node$/ }, (args) => {
            onNativeAddonImport({ path: args.path, importer: args.importer })
            return { path: args.path, external: true }
        })
    },
})

const analyseMetafile = async ({ metafile, qadamDir, repoRoot, nativeAddonImports, qadamConfig }) => {
    const inputPaths = Object.keys(metafile.inputs).map((p) => resolve(qadamDir, p))
    const platformDirs = Object.values(PLATFORM_PROVIDED_PACKAGES).map((p) => join(repoRoot, p) + sep)
    const inlinedPeers = unique(inputPaths
        .filter((p) => platformDirs.some((dir) => p.startsWith(dir)) || packageOfPath({ filePath: p })?.packageName === 'zod')
        .map((p) => packageOfPath({ filePath: p })?.packageName ?? relative(repoRoot, p)))

    const externalImports = unique(Object.values(metafile.outputs).flatMap((output) => output.imports.filter((i) => i.external).map((i) => i.path)))
    const peers = unique(externalImports.map((p) => PEER_PACKAGE_PATTERN.exec(p)?.[1]).filter(Boolean))
    const unresolvedOptional = externalImports.filter((p) => !isBuiltin(p) && !PEER_PACKAGE_PATTERN.test(p)
        && !qadamConfig.nodeModules.some((pkg) => p === pkg || p.startsWith(`${pkg}/`)) && !p.endsWith('.node'))

    const packageRoots = new Map(inputPaths.map((p) => packageOfPath({ filePath: p })).filter(Boolean).map((pkg) => [pkg.packageDir, pkg.packageName]))
    const addonPackages = nativeAddonImports.map(({ importer }) => packageOfPath({ filePath: importer })?.packageName).filter(Boolean)
    const signalled = await Promise.all([...packageRoots].map(async ([packageDir, packageName]) => ({ packageName, signals: await nativeSignals({ packageDir }) })))
    const detectedNative = unique([...addonPackages, ...signalled.filter((s) => s.signals.length > 0).map((s) => s.packageName)]).sort()
    const accepted = new Set([...qadamConfig.nodeModules, ...qadamConfig.optionalNative])
    const undeclaredNative = detectedNative.filter((pkg) => !accepted.has(pkg))

    const ownSources = inputPaths.filter((p) => p.startsWith(qadamDir + sep) && packageOfPath({ filePath: p }) === null)
    const ownRuntimeFileReferences = (await Promise.all(ownSources.map(async (file) => ((await referencesRuntimeFiles({ files: [file] })) ? relative(qadamDir, file) : null))))
        .filter(Boolean).sort()

    const runtimeFileRisk = (await Promise.all([...packageRoots].map(async ([packageDir, packageName]) => {
        const files = inputPaths.filter((p) => p.startsWith(packageDir + sep))
        return (await referencesRuntimeFiles({ files })) ? packageName : null
    }))).filter(Boolean)

    return {
        inlinedPeers,
        peers,
        undeclaredNative,
        ownRuntimeFileReferences,
        report: {
            peers,
            detectedNative,
            optionalNative: qadamConfig.optionalNative,
            nodeModulesPackages: qadamConfig.nodeModules,
            extraEntryPoints: qadamConfig.extraEntryPoints,
            unresolvedOptional,
            runtimeFileRisk: unique(runtimeFileRisk).sort(),
            ownRuntimeFileReferences,
            thirdPartyPackages: packageRoots.size,
        },
    }
}

const nativeSignals = async ({ packageDir }) => {
    const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8').catch(() => '{}'))
    const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
    const fromManifest = [
        manifest.gypfile === true ? 'gypfile' : null,
        manifest.binary ? 'binary' : null,
        ...NATIVE_LOADER_PACKAGES.filter((pkg) => pkg in declared).map((pkg) => `depends on ${pkg}`),
    ]
    const hasBindingGyp = await stat(join(packageDir, 'binding.gyp')).then(() => 'binding.gyp', () => null)
    // oracledb carries prebuilt addons and loads them by a computed path, so neither its manifest
    // nor a static `.node` import gives it away; the files on disk do.
    const shipsAddon = (await shipsNativeAddon({ packageDir })) ? 'ships a .node file' : null
    return [...fromManifest, hasBindingGyp, shipsAddon].filter(Boolean)
}

const shipsNativeAddon = ({ packageDir }) => {
    const cached = nativeAddonScanCache.get(packageDir)
    if (cached !== undefined) {
        return cached
    }
    const scan = readdir(packageDir, { recursive: true })
        .then((entries) => entries.some((entry) => entry.endsWith('.node') && !entry.split(sep).includes('node_modules')))
        .catch(() => false)
    nativeAddonScanCache.set(packageDir, scan)
    return scan
}

// Heuristic, reported for review rather than failed on: a bundled dependency that reads a file
// relative to its own location will look next to the bundle instead, and only fails when the code
// path runs — exactly the class of bug upstream hit with the Oracle runner (activepieces#14967).
const referencesRuntimeFiles = async ({ files }) => {
    const sources = await Promise.all(files.filter((f) => /\.(c|m)?(j|t)s$/.test(f)).map((f) => readFile(f, 'utf8').catch(() => '')))
    return sources.some((source) => /\b__dirname\b|\b__filename\b|import\.meta\.url|require\.resolve\(/.test(source))
}

const copyI18n = async ({ qadamDir, artifactDir }) => {
    const source = join(qadamDir, 'src', 'i18n')
    const files = await readdir(source).catch(() => [])
    const jsonFiles = files.filter((f) => f.endsWith('.json'))
    if (jsonFiles.length === 0) {
        return []
    }
    await mkdir(join(artifactDir, 'src', 'i18n'), { recursive: true })
    await Promise.all(jsonFiles.map((f) => cp(join(source, f), join(artifactDir, 'src', 'i18n', f))))
    return jsonFiles.map((f) => basename(f, '.json')).sort()
}

// Flat where possible, nested under the dependent where two versions of one name meet — the same
// placement npm's hoisting arrives at, so Node's upward lookup finds the version each package
// was resolved against in the workspace.
const copyNodeModulesClosure = async ({ roots, fromDir, artifactDir }) => {
    const placed = new Map()
    const topLevel = new Map()
    const queue = await Promise.all(roots.map(async (packageName) => ({
        packageName,
        sourceDir: await findPackageDir({ packageName, fromDir }),
        installParent: artifactDir,
    })))
    while (queue.length > 0) {
        const { packageName, sourceDir, installParent } = queue.shift()
        const manifest = JSON.parse(await readFile(join(sourceDir, 'package.json'), 'utf8'))
        const key = `${packageName}@${manifest.version}`
        const top = topLevel.get(packageName)
        const target = top === undefined || top === manifest.version
            ? join(artifactDir, 'node_modules', packageName)
            : join(installParent, 'node_modules', packageName)
        if (placed.has(`${key}:${target}`)) {
            continue
        }
        placed.set(`${key}:${target}`, true)
        if (top === undefined) {
            topLevel.set(packageName, manifest.version)
        }
        await cp(sourceDir, target, { recursive: true, dereference: true, filter: (src) => !src.slice(sourceDir.length).split(sep).includes('node_modules') })
        const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })
        const resolved = await Promise.all(dependencies.map(async (dependency) => ({
            packageName: dependency,
            sourceDir: await findPackageDir({ packageName: dependency, fromDir: sourceDir }).catch(() => null),
            installParent: target,
        })))
        // An optional dependency that was never installed (another platform's binary) is skipped,
        // as the package manager skipped it.
        queue.push(...resolved.filter((r) => r.sourceDir !== null))
    }
    return Object.fromEntries([...topLevel].sort(([a], [b]) => a.localeCompare(b)))
}

const computePeerDependencies = async ({ peers, repoRoot }) => {
    const entries = await Promise.all(peers.map(async (peer) => {
        const workspacePath = PLATFORM_PROVIDED_PACKAGES[peer]
        // The range names the copy the platform provides, which is what the bundle runs against —
        // not whatever the qadam happens to resolve (some import `zod` without declaring it).
        const manifestDir = workspacePath
            ? join(repoRoot, workspacePath)
            : await findPackageDir({ packageName: peer, fromDir: join(repoRoot, PLATFORM_PROVIDED_PACKAGES['@aiqadam/qadams-framework']) })
        const { version } = JSON.parse(await readFile(join(manifestDir, 'package.json'), 'utf8'))
        return [peer, `^${version}`]
    }))
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))
}

const buildArtifactPackageJson = ({ sourcePackageJson, kind, peerDependencies, nodeModules }) => {
    const optional = Object.fromEntries(['description', 'license', 'keywords', 'repository', 'homepage', 'author']
        .filter((field) => sourcePackageJson[field] !== undefined)
        .map((field) => [field, sourcePackageJson[field]]))
    const withNodeModules = kind === ARTIFACT_KIND.BUNDLE_WITH_NODE_MODULES
    return {
        name: sourcePackageJson.name,
        version: sourcePackageJson.version,
        ...optional,
        main: './src/index.js',
        peerDependencies,
        ...(withNodeModules ? { dependencies: nodeModules, bundleDependencies: Object.keys(nodeModules) } : {}),
        qadamArtifact: {
            formatVersion: ARTIFACT_FORMAT_VERSION,
            kind,
            // A native addon runs only where it was built; the store must not seed it elsewhere.
            ...(withNodeModules ? { builtFor: buildPlatform() } : {}),
        },
    }
}

const buildPlatform = () => {
    const glibc = process.report?.getReport?.().header?.glibcVersionRuntime
    return { os: process.platform, cpu: process.arch, libc: glibc ? `glibc ${glibc}` : 'unknown', node: process.versions.node }
}

const extractMetadata = async ({ artifactDir }) => {
    const child = join(import.meta.dirname, 'extract-artifact-metadata-child.mjs')
    try {
        const { stdout } = await execFileAsync(process.execPath, [child, artifactDir], {
            cwd: artifactDir,
            timeout: 120_000,
            maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, NODE_PATH: '' },
        })
        return { summary: JSON.parse(stdout.trim().split('\n').at(-1)) }
    }
    catch (e) {
        const stderr = summarizeChildError({ stderr: String(e?.stderr ?? '') })
        return { error: stderr || String(e?.message ?? e) }
    }
}

// Node prints the throwing source line and a stack; the `Error: ...` line and what follows it up
// to the stack is the part a report reader needs.
const summarizeChildError = ({ stderr }) => {
    const lines = stderr.split('\n').filter((line) => line.trim() !== '' && !/^\s+at /.test(line))
    const errorLine = lines.findIndex((line) => /^\w*Error\b|^\[extract-artifact-metadata\]/.test(line))
    return (errorLine === -1 ? lines.slice(-4) : lines.slice(errorLine, errorLine + 3)).join(' | ')
}

const packArtifact = async ({ artifactDir, packDestination }) => {
    try {
        await mkdir(packDestination, { recursive: true })
        const { stdout } = await execFileAsync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDestination], {
            cwd: artifactDir,
            timeout: 300_000,
            maxBuffer: 64 * 1024 * 1024,
        })
        const [packed] = JSON.parse(stdout)
        return {
            tarball: {
                file: packed.filename,
                integrity: packed.integrity,
                shasum: packed.shasum,
                size: packed.size,
                unpackedSize: packed.unpackedSize,
                entryCount: packed.entryCount,
            },
        }
    }
    catch (e) {
        return { error: String(e?.stderr ?? e?.message ?? e).trim().split('\n').slice(-3).join(' | ') }
    }
}

const findPackageDir = async ({ packageName, fromDir }) => {
    const start = await realpath(fromDir)
    const candidates = ancestors({ dir: start }).map((dir) => join(dir, 'node_modules', packageName))
    for (const candidate of candidates) {
        const found = await stat(join(candidate, 'package.json')).then(() => true, () => false)
        if (found) {
            return realpath(candidate)
        }
    }
    throw new Error(`cannot resolve ${packageName} from ${fromDir}`)
}

const ancestors = ({ dir }) => {
    const parent = dirname(dir)
    return parent === dir ? [dir] : [dir, ...ancestors({ dir: parent })]
}

const packageOfPath = ({ filePath }) => {
    const marker = `${sep}node_modules${sep}`
    const index = filePath.lastIndexOf(marker)
    if (index === -1) {
        return null
    }
    const rest = filePath.slice(index + marker.length).split(sep)
    const packageName = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]
    return { packageName, packageDir: filePath.slice(0, index + marker.length) + packageName.split('/').join(sep) }
}

const formatMessage = (message) => `${message.text}${message.location ? ` (${message.location.file}:${message.location.line})` : ''}`

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])

const directorySize = async ({ dir }) => {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    const sizes = await Promise.all(entries.filter((e) => e.isFile()).map((e) => stat(join(e.parentPath, e.name)).then((s) => s.size)))
    return sizes.reduce((sum, size) => sum + size, 0)
}

const symlinkDir = async ({ target, path }) => symlink(target, path, 'dir')

const normalizeQadamConfig = ({ raw }) => ({
    nodeModules: Object.keys(raw?.nodeModules ?? {}),
    optionalNative: Object.keys(raw?.optionalNative ?? {}),
    extraEntryPoints: Object.keys(raw?.extraEntryPoints ?? {}),
})

const unique = (values) => [...new Set(values)]
