import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const VENDOR_DIRECTORY = 'vendor'
const WORKSPACE_GLOB_CHARACTERS = /[*?[\]{}!]/
const MODULE_FILE_SUFFIXES = ['.js', '.cjs', '.mjs', '.d.ts', '.d.cts', '.d.mts']
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const
// The forms `tsc` emits: `require("x")` in CommonJS output; `import … from 'x'`, `export … from 'x'`,
// `import 'x'` and `import("x")` in declarations. Anchored to code shapes so a comment such as
// `// … from "it was already there" …` (records.dto.js) is not read as a dependency.
const SPECIFIER_PATTERNS = [
  /\brequire\(\s*["']([^"'\s]+)["']\s*\)/g,
  /\bimport\(\s*["']([^"'\s]+)["']\s*\)/g,
  /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s+["']([^"'\s]+)["']/gm,
  /^\s*\}\s*from\s+["']([^"'\s]+)["']/gm,
  /^\s*import\s+["']([^"'\s]+)["']/gm,
]

// ADR-0001: `@aiqadam/shared` is private, and `qadams-framework` ships what it uses from it — code
// and `.d.ts` — inside its own tarball. Keyed by the package being published; each value lists
// the private workspace packages that package carries. Anything not listed here may not depend on
// a private package at all, which `stagePackageForPublish` enforces for every package it stages.
//
// Bundled file for file, not through a bundler: the vendored `.js` and `.d.ts` are the bytes `tsc`
// emitted for the workspace, so the tarball runs the same code CI tested. Only the import
// specifiers that name the private package change, to a relative path into `vendor/`.
export const BUNDLED_PRIVATE_DEPENDENCIES: Record<string, string[]> = {
  '@aiqadam/qadams-framework': ['@aiqadam/shared'],
}

// Stages the package and hands `use` the directory to pack, returning what `use` returns. A
// package that bundles nothing is packed from `outputPath` as before. One that bundles is copied to
// a temporary directory first, so the workspace's own `dist` — which the API, engine and tests load
// — keeps requiring the workspace `shared` and never gains a second copy of it. That directory is
// removed once `use` returns or anything throws: a release packs every framework package and, with
// `--include-qadams`, the catalogue, and each staged framework is a ~4.5 MB copy of `shared`.
export const stagePackageForPublish = async <T>({ outputPath, workspaceRoot, bundledPrivateDependencies = BUNDLED_PRIVATE_DEPENDENCIES, use }: StagePackageForPublishParams<T>): Promise<T> => {
  const manifest = readJson(join(outputPath, 'package.json'))
  const privatePackages = findPrivateWorkspacePackages({ workspaceRoot })
  const toBundle = bundledPrivateDependencies[manifest.name] ?? []

  if (toBundle.length === 0) {
    assertPublishable({ publishRoot: outputPath, privatePackages })
    return use(outputPath)
  }

  const publishRoot = mkdtempSync(join(tmpdir(), 'qadam-flow-publish-stage-'))
  try {
    cpSync(outputPath, publishRoot, {
      recursive: true,
      // `prepareQadamDistForPublish` symlinks `dist/node_modules` to the source tree's; npm would
      // not pack it, and copying it would only follow the link into the workspace.
      filter: (source) => relative(outputPath, source).split(sep)[0] !== 'node_modules',
    })
    const stagedManifest = toBundle.reduce(
      (current, name) => vendorPrivatePackage({ publishRoot, manifest: current, privatePackage: privatePackages.get(name), name }),
      manifest,
    )
    writeFileSync(join(publishRoot, 'package.json'), JSON.stringify(stagedManifest, null, 2))
    assertPublishable({ publishRoot, privatePackages })
    // Awaited here, not returned as a promise: the `finally` must not remove the directory while
    // `npm pack` is still reading it.
    return await use(publishRoot)
  }
  finally {
    rmSync(publishRoot, { recursive: true, force: true })
  }
}

function assertPublishable({ publishRoot, privatePackages }: AssertNoPrivateDependenciesParams): void {
  dropPrivateDevDependencies({ publishRoot, privatePackages })
  assertNoPrivateDependencies({ publishRoot, privatePackages })
}

function vendorPrivatePackage({ publishRoot, manifest, privatePackage, name }: VendorPrivatePackageParams): PackageManifest {
  if (privatePackage === undefined) {
    throw new Error(`[stagePackageForPublish] ${manifest.name} is configured to bundle ${name}, but ${name} is not a private workspace package. Remove it from BUNDLED_PRIVATE_DEPENDENCIES or mark it private.`)
  }
  if (manifest.dependencies?.[name] === undefined) {
    throw new Error(`[stagePackageForPublish] ${manifest.name} is configured to bundle ${name}, but does not depend on it. Remove it from BUNDLED_PRIVATE_DEPENDENCIES.`)
  }
  const ownWorkspaceDependencies = Object.entries(privatePackage.manifest.dependencies ?? {}).filter(([, spec]) => spec.startsWith('workspace:'))
  if (ownWorkspaceDependencies.length > 0 || privatePackage.manifest.peerDependencies !== undefined) {
    throw new Error(`[stagePackageForPublish] ${name} has workspace or peer dependencies of its own (${ownWorkspaceDependencies.map(([dep]) => dep).join(', ')}); bundling it is not supported.`)
  }

  const entry = buildFile({ privatePackage, field: 'main', name })
  const types = buildFile({ privatePackage, field: 'types', name })
  const buildRoot = dirname(entry)
  if (dirname(types) !== buildRoot) {
    throw new Error(`[stagePackageForPublish] ${name}'s main (${entry}) and types (${types}) are not in one directory; only that directory is vendored.`)
  }
  if (buildRoot === resolve(privatePackage.directory)) {
    throw new Error(`[stagePackageForPublish] ${name}'s main and types sit at its package root; vendoring that directory would ship its sources, manifest and node_modules. Point them into the build output.`)
  }

  const vendorDirectory = join(publishRoot, VENDOR_DIRECTORY, unscopedName(name))
  const ownFiles = listFiles(publishRoot).filter(isModuleFile)
  cpSync(buildRoot, vendorDirectory, { recursive: true })
  const vendorEntry = join(vendorDirectory, relative(buildRoot, entry))

  for (const file of ownFiles) {
    const source = readFileSync(file, 'utf8')
    const rewritten = rewriteSpecifiers({ source, name, replacement: relativeSpecifier({ from: file, to: vendorEntry }), file })
    if (rewritten !== source) {
      writeFileSync(file, rewritten)
    }
  }

  const vendoredDependencies = externalPackagesUsedBy({ directory: vendorDirectory }).map((dependency) => {
    const version = privatePackage.manifest.dependencies?.[dependency]
    if (version === undefined) {
      throw new Error(`[stagePackageForPublish] the bundled ${name} uses ${dependency}, which ${name}'s package.json does not declare.`)
    }
    const existing = manifest.dependencies?.[dependency]
    if (existing !== undefined && existing !== version) {
      throw new Error(`[stagePackageForPublish] ${manifest.name} depends on ${dependency}@${existing}, the bundled ${name} on ${dependency}@${version}. Align them before publishing.`)
    }
    return [dependency, version] as const
  })

  const remaining = Object.entries(manifest.dependencies ?? {}).filter(([dependency]) => dependency !== name)
  return {
    ...manifest,
    dependencies: Object.fromEntries([...remaining, ...vendoredDependencies].sort(([a], [b]) => a.localeCompare(b))),
  }
}

// A devDependency on a private package (`common` tests against `shared`) is the repository's own
// test setup. Consumers never install devDependencies, but the version it names is never on the
// registry, so it is left out of the published manifest rather than shipped as a dead reference.
function dropPrivateDevDependencies({ publishRoot, privatePackages }: AssertNoPrivateDependenciesParams): void {
  const manifestPath = join(publishRoot, 'package.json')
  const manifest = readJson(manifestPath)
  const devDependencies = Object.entries(manifest.devDependencies ?? {})
  const kept = devDependencies.filter(([dependency]) => !privatePackages.has(dependency))
  if (kept.length !== devDependencies.length) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, devDependencies: Object.fromEntries(kept) }, null, 2))
  }
}

// Two checks, both on what is about to be packed: the manifest names no private workspace package,
// and no emitted `.js` / `.d.ts` still imports one.
// The second is what catches a type that only reaches a package through declaration emit. It reads
// only specifiers in an import/require/export shape, like `externalPackagesUsedBy` below: a string
// literal that merely equals a private package's name (`channel: 'web'`, an `"api/v2"` path) is a
// value, and the naive quoted-string scan refused 14 real qadams on exactly those.
function assertNoPrivateDependencies({ publishRoot, privatePackages }: AssertNoPrivateDependenciesParams): void {
  const manifest = readJson(join(publishRoot, 'package.json'))
  const declared = DEPENDENCY_FIELDS.flatMap((field) =>
    Object.keys(manifest[field] ?? {}).filter((dependency) => privatePackages.has(dependency)).map((dependency) => `${field}.${dependency}`),
  )
  const imported = listFiles(publishRoot).filter(isModuleFile).flatMap((file) =>
    specifiersIn({ source: readFileSync(file, 'utf8') })
      .filter((specifier) => isPrivateSpecifier({ specifier, privatePackages }))
      .map((specifier) => `${relative(publishRoot, file)} imports ${specifier}`),
  )
  if (declared.length > 0 || imported.length > 0) {
    throw new Error(`[stagePackageForPublish] refusing to publish ${manifest.name}@${manifest.version}: it reaches a private workspace package, which is not on the registry:\n  ${[...declared, ...imported].join('\n  ')}`)
  }
}

// The package itself or a subpath of it. A subpath is refused rather than rewritten: only the
// package root can be vendored.
function isPrivateSpecifier({ specifier, privatePackages }: IsPrivateSpecifierParams): boolean {
  return [...privatePackages.keys()].some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

// `main` / `types` of the package to vendor, as an existing file inside its own directory: an empty
// or missing field would resolve to the package directory itself, and `../` would reach outside it,
// and either would vendor whatever sits there.
function buildFile({ privatePackage, field, name }: BuildFileParams): string {
  const value = privatePackage.manifest[field]
  if (value === undefined || value.trim() === '') {
    throw new Error(`[stagePackageForPublish] ${name} declares no "${field}"; the bundling package needs it to find ${name}'s build output.`)
  }
  const directory = resolve(privatePackage.directory)
  const file = resolve(directory, value)
  const fromPackage = relative(directory, file)
  if (fromPackage === '' || fromPackage === '..' || fromPackage.startsWith(`..${sep}`) || isAbsolute(fromPackage)) {
    throw new Error(`[stagePackageForPublish] ${name}'s "${field}" (${value}) resolves outside its package directory (${directory}).`)
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`[stagePackageForPublish] ${name}'s "${field}" (${file}) is not a file. Build ${name} before packing the package that bundles it.`)
  }
  return file
}

function rewriteSpecifiers({ source, name, replacement, file }: RewriteSpecifiersParams): string {
  if (specifiersIn({ source }).some((specifier) => specifier.startsWith(`${name}/`))) {
    throw new Error(`[stagePackageForPublish] ${file} imports a subpath of ${name}; only the package root can be bundled.`)
  }
  return source.replace(
    new RegExp(`(require\\(|import\\(|from |import )(["'])${escapeRegExp(name)}\\2`, 'g'),
    (_match, prefix: string, quote: string) => `${prefix}${quote}${replacement}${quote}`,
  )
}

function externalPackagesUsedBy({ directory }: { directory: string }): string[] {
  const specifiers = listFiles(directory).filter(isModuleFile).flatMap((file) =>
    specifiersIn({ source: readFileSync(file, 'utf8') }),
  )
  const packages = specifiers
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && !builtinModules.includes(specifier))
    .map((specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/'))
  return [...new Set(packages)].sort()
}

function specifiersIn({ source }: { source: string }): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))
}

// Only the two pattern forms the root manifest uses, `<dir>` and `<dir>/*` (the same two
// tools/ci/check-changesets.mjs expands). Anything else — `**`, a mid-path `*`, a negation, a brace —
// is refused rather than read as a literal directory that does not exist: a private package missed
// here is a private package the publish-time assertion never looks for.
function findPrivateWorkspacePackages({ workspaceRoot }: { workspaceRoot: string }): Map<string, WorkspacePackage> {
  const { workspaces } = readJson(join(workspaceRoot, 'package.json'))
  if (!isStringArray(workspaces) || workspaces.length === 0) {
    throw new Error(`[stagePackageForPublish] ${join(workspaceRoot, 'package.json')} declares no "workspaces"; without them no private workspace package can be found, and the private-package check would pass vacuously.`)
  }
  const directories = workspaces.flatMap((pattern) => {
    const literal = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern
    if (literal === '' || WORKSPACE_GLOB_CHARACTERS.test(literal)) {
      throw new Error(`[stagePackageForPublish] workspace pattern '${pattern}' is neither a directory nor <directory>/*; it is not expanded here.`)
    }
    if (!pattern.endsWith('/*')) {
      return [join(workspaceRoot, pattern)]
    }
    const parent = join(workspaceRoot, literal)
    return existsSync(parent)
      ? readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(parent, entry.name))
      : []
  })
  const packages = directories
    .filter((directory) => existsSync(join(directory, 'package.json')))
    .map((directory) => ({ directory, manifest: readJson(join(directory, 'package.json')) }))
    .filter(({ manifest }) => manifest.private === true)
  return new Map(packages.map((workspacePackage) => [workspacePackage.manifest.name, workspacePackage]))
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== 'node_modules')
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        return listFiles(path)
      }
      return entry.isFile() ? [path] : []
    })
}

function isModuleFile(file: string): boolean {
  return MODULE_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix))
}

function relativeSpecifier({ from, to }: { from: string, to: string }): string {
  const path = relative(dirname(from), to).split(sep).join('/')
  return path.startsWith('.') ? path : `./${path}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function unscopedName(name: string): string {
  return name.split('/').pop() ?? name
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8'))
}

type PackageManifest = {
  name: string
  version: string
  private?: boolean
  main?: string
  types?: string
  workspaces?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type WorkspacePackage = {
  directory: string
  manifest: PackageManifest
}

type StagePackageForPublishParams<T> = {
  outputPath: string
  workspaceRoot: string
  bundledPrivateDependencies?: Record<string, string[]>
  use: (publishRoot: string) => T | Promise<T>
}

type VendorPrivatePackageParams = {
  publishRoot: string
  manifest: PackageManifest
  privatePackage: WorkspacePackage | undefined
  name: string
}

type AssertNoPrivateDependenciesParams = {
  publishRoot: string
  privatePackages: Map<string, WorkspacePackage>
}

type BuildFileParams = {
  privatePackage: WorkspacePackage
  field: 'main' | 'types'
  name: string
}

type IsPrivateSpecifierParams = {
  specifier: string
  privatePackages: Map<string, WorkspacePackage>
}

type RewriteSpecifiersParams = {
  source: string
  name: string
  replacement: string
  file: string
}
