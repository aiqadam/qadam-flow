#!/usr/bin/env node
//
// The SDK half of ADR-0001 gate 2: compute the public API surface a qadam compiles against for
// `@aiqadam/qadams-framework` and `@aiqadam/qadams-common`, at the PR's base and head, so
// check-changeset-levels.mjs can demand a changeset level that is not below the computed one.
//
// WHAT "THE PUBLIC SURFACE" IS
// The package's entry point — `<pkg>/src/index.ts`, which both SDK packages publish as their
// `types` target — and the *declarations it exports*, taken from the TypeScript declaration emit of
// that entry's module graph. Emitting (rather than reading the source) is what makes this a `.d.ts` diff: a function
// body, a local refactor or a JSDoc edit is invisible, a changed signature or a narrowed type alias
// is not. For a re-export (`export { X } from '@aiqadam/shared'`) the surface takes X's own emitted
// declaration, not the re-export line, so a narrowing that reaches a qadam through a re-export is
// still seen — which is the point of the `shared` re-exports in `qadams-framework/src/lib/shared-reexports.ts`.
//
// HOW THE TWO ENDS ARE READ
// Files are read from git at the given SHA through an in-memory compiler host: the program's file
// names are the repo-relative absolute paths (identical at both ends), so an `import("<path>")` in
// an emitted `.d.ts` compares equal across base and head unless the type really moved. A bare
// `@aiqadam/*` specifier is resolved through the workspace `tsconfig.base.json` `paths` (source, not
// the built `dist`), so this works whether or not `shared` is bundled into the framework's tarball
// (#822/#799) and whether or not any package has been built. Third-party specifiers (`zod`, `ai`, …)
// resolve through the checked-out `node_modules` like any tsc run. When `tsconfig.base.json` is absent
// (fixture repos), no `paths` are set and packages that import each other are simply unresolved.
//
// WHAT IT CANNOT SEE
// - A type whose declaration text is unchanged but whose *behaviour* changed. Same doctrine as the
//   qadam half: a behaviour change is the PR-template question, not a gate.
// - Widening from narrowing. Any change to a declaration's text reads as breaking, including one
//   that is safe for every consumer (an added optional interface member, a widened union). The gate
//   only ever demands a higher level, so this can over-demand; the `semver-override` label covers it.
// - A re-export when the workspace `paths` cannot resolve the target (no `tsconfig.base.json`): the
//   symbol is then compared as its bare name, so a real change to the target is invisible. In this
//   repo `tsconfig.base.json` maps `@aiqadam/shared`, so the case does not arise.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

export const sdkApiSurface = {
  computeChanges: (...args) => computeChanges(...args),
}

const PACKAGES_DIR = 'packages'
const TS_CONFIG = 'tsconfig.base.json'
const DEFAULT_OPTIONS = {
  target: 'es2020',
  module: 'commonjs',
  moduleResolution: 'node',
  lib: ['es2022', 'dom'],
  strict: true,
  skipLibCheck: true,
}

// packages: [{ name, dir, version }]. Returns Map<name, { findings, kind, baseVersion, note }>.
// A package whose entry point exists at neither end is not reported (nothing to compare). It is
// included when it exists at the base alone, so deleting or renaming the entry — which drops the
// whole public surface — is a removal of every export, not a silent "nothing to compare".
const computeChanges = ({ range, packages, repoRoot }) => {
  const roots = packages
    .map((pkg) => ({ pkg, relative: `${pkg.dir}/src/index.ts`, entry: posix(path.join(repoRoot, `${pkg.dir}/src/index.ts`)) }))
    .filter(({ relative }) => fileAt({ sha: range.base, file: relative }) !== null || fileAt({ sha: range.head, file: relative }) !== null)

  const changes = new Map()
  if (roots.length === 0) {
    return changes
  }
  const base = buildSurfaces({ sha: range.base, roots, repoRoot })
  const head = buildSurfaces({ sha: range.head, roots, repoRoot })

  for (const { pkg, entry } of roots) {
    const before = base.surfaces.get(pkg.name) ?? new Map()
    const after = head.surfaces.get(pkg.name) ?? new Map()
    const baseManifest = readJson({ text: fileAt({ sha: range.base, file: `${pkg.dir}/package.json` }) })
    if (baseManifest === null) {
      changes.set(pkg.name, { findings: [], kind: 'fix', baseVersion: null, note: 'new package, nothing to compare against' })
      continue
    }
    if (before.size === 0 && after.size === 0) {
      changes.set(pkg.name, { findings: [], kind: 'fix', baseVersion: baseManifest.version, note: `no public surface at ${posix(entry)}` })
      continue
    }
    const findings = diffSurfaces({ before, after })
    const kind = findings.some((finding) => finding.kind === 'breaking') ? 'breaking' : findings.some((finding) => finding.kind === 'feature') ? 'feature' : 'fix'
    changes.set(pkg.name, { findings, kind, baseVersion: baseManifest.version })
  }
  return changes
}

const buildSurfaces = ({ sha, roots, repoRoot }) => {
  const options = compilerOptions({ repoRoot })
  const host = compilerHost({ sha, repoRoot, options })
  const program = ts.createProgram({ rootNames: roots.map(({ entry }) => entry), options, host })
  const emitted = new Map()
  program.emit(undefined, (fileName, text) => {
    if (fileName.endsWith('.d.ts')) {
      emitted.set(posix(fileName), text)
    }
  }, undefined, true)
  const indexCache = new Map()
  return {
    surfaces: new Map(roots.map(({ pkg, entry }) => [pkg.name, extractSurface({ program, entry, emitted, indexCache, repoRoot })])),
  }
}

// Names exported by the entry module, each mapped to the normalized text of its emitted declaration.
// `checker.getExportsOfModule` resolves `export *` chains and named re-exports, including through
// `shared`; an alias symbol is followed to the declaration it points at, so a re-exported type is
// compared by its own declaration, not by the re-export statement.
const extractSurface = ({ program, entry, emitted, indexCache, repoRoot }) => {
  const checker = program.getTypeChecker()
  const sourceFile = findSourceFile({ program, entry })
  if (!sourceFile) {
    return new Map()
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile) ?? sourceFile.symbol
  if (!moduleSymbol) {
    return new Map()
  }
  const surface = new Map()
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = exported.getName()
    const target = resolveAlias({ checker, symbol: exported })
    const declaration = (target.declarations ?? exported.declarations ?? [])[0]
    surface.set(name, declaration ? declarationText({ declaration, name, emitted, indexCache, repoRoot }) : '')
  }
  return surface
}

const findSourceFile = ({ program, entry }) => {
  return program.getSourceFile(entry) ?? program.getSourceFiles().find((file) => posix(file.fileName) === entry) ?? null
}

const resolveAlias = ({ checker, symbol }) => {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) {
    return symbol
  }
  const resolved = tryCatch(() => checker.getAliasedSymbol(symbol))
  return resolved.error ? symbol : resolved.data
}

const declarationText = ({ declaration, name, emitted, indexCache, repoRoot }) => {
  const emittedFile = emittedPath(declaration.getSourceFile().fileName)
  const text = emitted.get(emittedFile)
  if (text !== undefined) {
    const index = indexCache.get(emittedFile) ?? indexDeclarations({ text })
    indexCache.set(emittedFile, index)
    const found = index.get(name)
    if (found !== undefined) {
      return normalizeText({ text: found, repoRoot })
    }
  }
  return normalizeText({ text: signatureText({ declaration }), repoRoot })
}

// Top-level declaration name -> its statement text, for one emitted `.d.ts`. Deliberately ignores
// `export ... from` statements: the surface resolves those to the declaration they point at, which
// lives in the target file. A name declared here but not exported is still indexed, so an aliased
// symbol whose declaration is non-exported in its own file is found.
const indexDeclarations = ({ text }) => {
  const sourceFile = ts.createSourceFile('surface.d.ts', text, ts.ScriptTarget.Latest, true)
  const index = new Map()
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          index.set(declaration.name.text, statement.getText(sourceFile))
        }
      }
      continue
    }
    const name = statementName({ statement })
    if (name !== null) {
      index.set(name, statement.getText(sourceFile))
    }
  }
  return index
}

const statementName = ({ statement }) => {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
    return statement.name && ts.isIdentifier(statement.name) ? statement.name.text : null
  }
  return null
}

// A declaration's signature without its body, for the fallback when no emitted `.d.ts` was indexed.
const signatureText = ({ declaration }) => {
  const sourceFile = declaration.getSourceFile()
  const start = declaration.getStart(sourceFile)
  const body = declaration.body
  if (body && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration))) {
    return sourceFile.text.slice(start, body.getStart(sourceFile))
  }
  return declaration.getText(sourceFile)
}

const diffSurfaces = ({ before, after }) => {
  const findings = []
  for (const [name, was] of before) {
    const now = after.get(name)
    if (now === undefined) {
      findings.push({ kind: 'breaking', text: `export '${name}' removed` })
      continue
    }
    if (was !== now) {
      findings.push({ kind: 'breaking', text: `export '${name}' signature changed` })
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) {
      findings.push({ kind: 'feature', text: `export '${name}' added` })
    }
  }
  return findings
}

// --- compiler host: git-backed for `packages/**`, the real filesystem for everything else --------

// Preload the sources the SDK graph actually reaches, in one `git cat-file --batch` per side. A
// per-file `git show` is correct but ~250 process spawns per side; the batch is two. Any other
// workspace package still resolves, lazily, through `git show`. Keep this in step with SDK_PACKAGES
// in check-changeset-levels.mjs: a new SDK package whose sources are not listed here still works
// (lazily), just slower.
const PRELOAD_DIRS = ['packages/shared', 'packages/qadams/framework', 'packages/qadams/common']

const compilerHost = ({ sha, repoRoot, options }) => {
  const files = listFiles({ sha, dir: PACKAGES_DIR, repoRoot })
  const preloaded = preloadContents({ sha, dirs: PRELOAD_DIRS })
  const lazy = new Map()
  const defaultHost = ts.createCompilerHost(options, true)
  const overlayRelative = (fileName) => {
    const relative = posix(path.relative(repoRoot, fileName))
    return relative.startsWith(`${PACKAGES_DIR}/`) && !relative.startsWith('..') ? relative : null
  }
  const readOverlay = (relative) => {
    if (preloaded.has(relative)) {
      return preloaded.get(relative)
    }
    if (!files.has(relative)) {
      return undefined
    }
    if (!lazy.has(relative)) {
      lazy.set(relative, gitShow({ sha, file: relative }))
    }
    return lazy.get(relative)
  }
  const directories = new Set()
  for (const file of files) {
    let dir = posix(path.dirname(file))
    while (dir.startsWith(PACKAGES_DIR) && !directories.has(dir)) {
      directories.add(dir)
      dir = posix(path.dirname(dir))
    }
  }
  const host = {
    ...defaultHost,
    readFile: (fileName) => {
      const relative = overlayRelative(fileName)
      return relative === null ? defaultHost.readFile(fileName) : readOverlay(relative)
    },
    fileExists: (fileName) => {
      const relative = overlayRelative(fileName)
      return relative === null ? defaultHost.fileExists(fileName) : files.has(relative)
    },
    directoryExists: (dirName) => {
      const relative = overlayRelative(dirName)
      return relative === null ? (defaultHost.directoryExists?.(dirName) ?? true) : directories.has(relative)
    },
    getDirectories: (dirName) => {
      const relative = overlayRelative(dirName)
      if (relative === null) {
        return defaultHost.getDirectories(dirName)
      }
      const prefix = `${relative}/`
      const names = new Set()
      for (const file of files) {
        if (file.startsWith(prefix)) {
          names.add(file.slice(prefix.length).split('/')[0])
        }
      }
      return [...names]
    },
  }
  // `createCompilerHost`'s own `getSourceFile` closes over the filesystem `readFile`, not the one on
  // the returned object, so overriding `readFile` alone leaves root files read from the working tree.
  // Every source file must go through the overlay, or base and head both read the head's tree. The
  // cache is load-bearing: TS binds symbols to one `SourceFile` per path, so returning a fresh object
  // for the same file breaks alias resolution (`export { X } from …` stops pointing at X).
  const sourceFiles = new Map()
  const getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (shouldCreateNewSourceFile || !sourceFiles.has(fileName)) {
      const text = host.readFile(fileName)
      const sourceFile = text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true)
      if (shouldCreateNewSourceFile) {
        return sourceFile
      }
      sourceFiles.set(fileName, sourceFile)
    }
    return sourceFiles.get(fileName)
  }
  host.getSourceFile = getSourceFile
  host.getSourceFileByPath = (fileName, path, languageVersion, onError, shouldCreateNewSourceFile) => getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  return host
}

const preloadContents = ({ sha, dirs }) => {
  const listing = tryCatch(() => git({ args: ['ls-tree', '-r', sha, '--', ...dirs] }))
  if (listing.error) {
    throw new Error(`cannot list ${dirs.join(', ')} at ${sha}: ${listing.error.message}`)
  }
  const entries = listing.data.split('\n').filter(Boolean).map((line) => {
    const [meta, file] = line.split('\t')
    return { oid: meta.split(/\s+/)[2], file }
  }).filter((entry) => entry.oid && entry.file)
  if (entries.length === 0) {
    return new Map()
  }
  const out = execFileSync('git', ['cat-file', '--batch'], { input: `${entries.map((entry) => entry.oid).join('\n')}\n`, maxBuffer: 256 * 1024 * 1024 })
  const contentByFile = new Map()
  let cursor = 0
  for (const entry of entries) {
    const headerEnd = out.indexOf(0x0a, cursor)
    if (headerEnd < 0) {
      break
    }
    const header = out.toString('utf-8', cursor, headerEnd)
    cursor = headerEnd + 1
    // `<oid> <type> <size>` for a present object; `<oid> missing` for one the batch could not read.
    const [, type, size] = header.split(' ')
    if (type === undefined || type === 'missing') {
      continue
    }
    const length = Number(size)
    if (!Number.isFinite(length)) {
      continue
    }
    // The body follows for every type (blob, tree, commit on a submodule), so advance the cursor
    // unconditionally — leaving a non-blob body in the buffer desyncs every later entry.
    if (type === 'blob') {
      contentByFile.set(entry.file, out.toString('utf-8', cursor, cursor + length))
    }
    cursor += length + 1
  }
  return contentByFile
}

const compilerOptions = ({ repoRoot }) => {
  const config = tryCatch(() => fs.readFileSync(path.join(repoRoot, TS_CONFIG), 'utf-8'))
  const parsed = config.error ? {} : (tryCatch(() => JSON.parse(config.data)).data ?? {})
  const json = { ...DEFAULT_OPTIONS, ...(parsed.compilerOptions ?? parsed) }
  const converted = ts.convertCompilerOptionsFromJson(json, repoRoot).options
  return {
    ...converted,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    removeComments: true,
    skipLibCheck: true,
    noEmitOnError: false,
    incremental: false,
    composite: false,
    importHelpers: false,
    types: [],
    typeRoots: [],
  }
}

const listFiles = ({ sha, dir, repoRoot }) => {
  const out = tryCatch(() => git({ args: ['ls-tree', '-r', '--name-only', `${sha}:${dir}`], repoRoot }))
  if (out.error) {
    throw new Error(`cannot list ${dir} at ${sha}: ${out.error.message}`)
  }
  return new Set(out.data.split('\n').map((line) => `${dir}/${line}`).filter(Boolean))
}

const emittedPath = (fileName) => posix(fileName).replace(/\.(tsx?|mts|cts)$/, '.d.ts')

const normalizeText = ({ text, repoRoot }) => {
  return text
    .split(posix(repoRoot)).join('«repo»')
    .replace(/\s+/g, ' ')
    .trim()
}

const fileAt = ({ sha, file }) => {
  const result = tryCatch(() => gitShow({ sha, file }))
  return result.error ? null : result.data
}

const gitShow = ({ sha, file }) => git({ args: ['show', `${sha}:${file}`] })

const git = ({ args }) => execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).replace(/\n$/, '')

const readJson = ({ text }) => {
  if (text === null) {
    return null
  }
  const parsed = tryCatch(() => JSON.parse(text))
  return parsed.error ? null : parsed.data
}

const posix = (value) => value.split(path.sep).join('/')

const tryCatch = (fn) => {
  try {
    return { data: fn(), error: null }
  }
  catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error(String(error)) }
  }
}
