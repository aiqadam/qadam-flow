#!/usr/bin/env node
/**
 * workspace-to-file.cjs — npm-compat manifest derivation for the Debian build.
 *
 * The repo is bun-canonical: "workspace:*" dependency specs and `resolutions`.
 * npm rejects the workspace protocol outright (EUNSUPPORTEDPROTOCOL) and
 * forbids overriding a package the root depends on directly (EOVERRIDE when
 * `rollup` is both a direct dependency and an overrides alias). The Debian
 * prebuild runs the whole toolchain inside a disposable copy (build/source,
 * see scripts/debian-prebuild.sh) and derivES the npm-compatible manifests
 * THERE — the repo working tree is never written:
 *
 *   node scripts/workspace-to-file.cjs apply <targetRoot>
 *
 * Derivation, mechanical:
 *   - root package.json: an `overrides` block; `resolutions` are mirrored and
 *     every additional bun.lock pin is layered in below them so npm builds the
 *     same tree bun validated (see the bun canon rules below); direct deps
 *     that the overrides redirect are dropped (npm EOVERRIDE — the
 *     `rollup -> npm:@rollup/wasm-node` alias stands in for the direct entry;
 *     the `@rollup/wasm-node` dependency pins the version the alias resolves
 *     to, it has no import site). `packageManager` becomes npm (no bun on the
 *     build host) and the copy's .npmrc gets the allow-scripts approvals for
 *     the native builders npm ≥ 12 would otherwise skip.
 *   - bun canon (why overrides go beyond resolutions): bun.lock is the repo's
 *     dependency gate — CI and the Docker image build against ITS pins, but it
 *     was written possibly long ago (e.g. @codemirror/lint = 6.9.5), while a
 *     fresh npm resolution floats every caret to today's latest. Those
 *     floated picks can silently disagree with the exact-pinned neighbours the
 *     manifests keep (web build died on @codemirror/lint@6.9.7 needing an
 *     `activateHover` export @codemirror/view 6.40.0 never grew instead of
 *     bun's validated 6.9.5). Rule: every bun.lock name resolved to exactly
 *     ONE semver version becomes an override; names bun resolves to several
 *     versions (393 of them — nested ranges of big SDK families) cannot be
 *     flattened by npm's single-version-per-name overrides and are left to
 *     npm's caret resolution. Workspace members ("@aiqadam/*" via
 *     workspace: specs) are excluded — the file: derivation covers them.
 *   - member manifests: bun-style "workspace:*" / "workspace:^x" specs become
 *     npm `file:` specs; members pinning an exact version that differs from
 *     the mirrored override are aligned to it (resolutions force ONE global
 *     copy in bun — npm keeps them disjoint: the regen then records only the
 *     forced version in the lock and `npm ci` rejects the pin as Missing).
 *
 * The vendored payload ships the REPO manifests (workspace:*): the prebuild
 * copies the originals back over build/source before staging. Nothing parses
 * dep specs outside installs, so the .deb determinantly carries the
 * bun-canonical spelling.
 */
'use strict'

const fs = require('fs')
const path = require('path')
// `packageManager` needs npm's version; process.versions does not carry it on
// modern node, and npx/npm on PATH is exactly what the prebuild will pass to
// turbo — resolve the CLI version the same way.
const npmVersion = () => require('child_process').execFileSync('npm', ['--version'], { encoding: 'utf8' })

const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

// npm ≥ 12 blocks dependency install scripts unless `allowScripts` approves
// them (npm 11.19 already skips silently on this dev host); a skipped script
// keeps `npm ci` exit 0 — isolated-vm 7.0.1 ships prebuilds only for
// darwin-arm64, so on Linux the native build MUST run or the payload starts
// without a sandbox binding. The approval lives in .npmrc ONLY: when the
// package.json field exists it ignores (npm 11.19: "the .npmrc allow-scripts
// setting is being ignored because package.json declares its own
// allowScripts field"), so writing BOTH would approve nothing on that
// engine. The .npmrc line is the project-scoped form both npm 11 and 12
// sanction — the field+CLI flow is the other documented option. Name-only
// entries: the lock pins the content anyway.
// Deliberately NOT approved: @openrouter/sdk, core-js, protobufjs,
// exifreader (informational postinstalls), fastify-socket (its preinstall
// enforces pnpm), redis-memory-server (downloads mongo bits for dev tests).
const ALLOW_SCRIPTS = [
    'bcrypt', 'cpu-features', 'couchbase', 'esbuild', 'isolated-vm',
    'msgpackr-extract', 'oracledb', 'sqlite3', 'ssh2', 'unrs-resolver',
]

// bun-store flatten: @ai-sdk/provider whose manifest pins ALIAS the version
// bun actually installed. The three server packages pin @ai-sdk/provider at
// 4.0.33, but bun's own store has no 4.0.33 branch (only 4.0.15/18/21/29 are
// installed) and their local node_modules links resolve at 4.0.29 — the tree
// CI validated. npm's fresh resolution takes the manifest pins at face value:
// root provider at 4.0.33 (hoisted) + nested copies at 4.0.29, and the two
// d.ts sets disagree (`finishReason`'s `interrupted` member exists only in
// 4.0.33) so tsc refuses to type-match across them (the d.ts split the bun
// store never had). Flattening provider to the bun-validated version replaces
// the split with one d.ts; alignOverride then rewrites the 4.0.33 member
// pins down to the override, matching what bun resolves.
//
// @ai-sdk/provider-utils must NOT be flattened: a global 5.0.62 starves
// @ai-sdk/gateway, whose compiled output imports the experimental-speech
// exports that only exist in 5.0.67 — esbuild rejects the imports mid-build.
// The provider override above covers every provider-utils branch anyway
// (each branch's exact provider dependency resolves to one shared 4.0.29),
// so the type graph stays single-provider without the utils flatten.
const BUN_FLATTEN = {
    '@ai-sdk/provider': '4.0.29',
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// Turn a workspaces entry (relative to targetRoot) into a directory list:
// fixed paths as-is, one-level globs ("packages/qadams/core/*") expanded by
// readdir.
const workspaceDirs = (targetRoot, entry) => {
    const parts = entry.split('/')
    const last = parts[parts.length - 1]
    if (!last.includes('*')) {
        return [entry]
    }
    const parent = parts.slice(0, -1).join('/')
    if (!fs.existsSync(path.join(targetRoot, parent))) {
        return []
    }
    return fs.readdirSync(path.join(targetRoot, parent))
        .map((name) => path.posix.join(parent, name))
        .filter((dir) => fs.statSync(path.join(targetRoot, dir)).isDirectory())
}

const collectPackages = (targetRoot, rootPkg) => {
    const files = []
    for (const entry of rootPkg.workspaces ?? []) {
        for (const dir of workspaceDirs(targetRoot, entry)) {
            const file = `${dir}/package.json`
            // glob parents may carry bare namespace directories
            // (packages/qadams in a "packages/*"-style glob) — skip anything
            // that is not a real member manifest
            if (fs.existsSync(path.join(targetRoot, file))) {
                files.push(file)
            }
        }
    }
    return files
}

const rebuildWorkspaceMap = (targetRoot, rootPkg) => {
    const byName = new Map()
    for (const file of collectPackages(targetRoot, rootPkg)) {
        const pkg = readJson(path.join(targetRoot, file))
        if (pkg.name) {
            byName.set(pkg.name, path.posix.dirname(file))
        }
    }
    return byName
}

// npm-compat root manifest: mirror `resolutions` into `overrides`, then drop
// the direct deps that the overrides redirect (npm refuses EOVERRIDE).
// Is this a pinned literal ("6.2.1") rather than a range spec?
const isExactVersion = (spec) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(spec)

// bun.lock ("configVersion" 0, jsonc-flavored) is the repo's dependency gate —
// CI and the Docker image build against its pins. Entries (packages section)
// map a name or name@range to ["name@version", "", {...}, sha512...] and may
// carry an npm: prefix (manifest aliases). bun resolves MOST names to exactly
// one semver version: those become overrides so npm builds the same tree bun
// validated — a fresh npm resolution floats every caret to today's latest and
// silently disagrees with the exact-pinned neighbours the manifests keep.
// Names bun resolves to several versions (390ish: nested ranges of big SDK
// families) cannot be flattened — npm overrides pin ONE version per name — and
// are left to npm's caret resolution. Workspace members (pkg@workspace:...)
// are ignored here: the file: derivation covers them.
const SEMVER_SPEC = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/
const readBunCanon = (targetRoot) => {
    const file = path.join(targetRoot, 'bun.lock')
    if (!fs.existsSync(file)) {
        return null
    }
    const raw = fs.readFileSync(file, 'utf8')
    let lock
    try {
        lock = JSON.parse(raw)
    } catch {
        lock = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'))
    }
    const groups = new Map()
    for (const value of Object.values(lock.packages ?? {})) {
        if (!Array.isArray(value) || typeof value[0] !== 'string') continue
        let spec = value[0]
        if (spec.startsWith('npm:')) spec = spec.slice(4)
        const at = spec.lastIndexOf('@')
        if (at <= 0) continue
        const name = spec.slice(0, at)
        const version = spec.slice(at + 1)
        const validName = name.startsWith('@') ? /^@[^/]+\/[^/]+$/.test(name) : /^[^@/]+$/.test(name)
        if (!SEMVER_SPEC.test(version) || !validName) continue
        const versions = groups.get(name) ?? new Set()
        versions.add(version)
        groups.set(name, versions)
    }
    const pins = {}
    let conflicts = 0
    for (const [name, versions] of groups) {
        if (versions.size === 1) {
            pins[name] = [...versions][0]
        } else {
            conflicts += 1
        }
    }
    return { pins, conflicts }
}

// npm ci validates each workspace member's declared spec against the lock,
// while an override forces ONE version for the whole tree and the lock then
// records only the forced version — a member pinning another exact version
// makes `npm ci` fail with "Missing: <name>@<pin> from lock file" (regen
// respects the override, ci checks the pin verbatim). Bun resolves the same
// tree FORCED to the resolutions version (one global copy), so aligning the
// derived member pins to the override keeps the npm build on bun's semantics.
const alignOverride = ({ deps, overrides, file, counter }) => {
    let touched = false
    for (const [name, spec] of Object.entries(deps)) {
        const forced = overrides[name]
        if (typeof spec !== 'string' || typeof forced !== 'string'
            || forced === spec
            || !isExactVersion(spec) || !isExactVersion(forced)) {
            continue
        }
        deps[name] = forced
        counter.aligned += 1
        touched = true
        console.log(`workspace-to-file: ${file} ${name} ${spec} -> ${forced} (override)`)
    }
    return touched
}

const deriveRoot = (targetRoot) => {
    const file = path.join(targetRoot, 'package.json')
    const pkg = readJson(file)
    if (!pkg.resolutions || Object.keys(pkg.resolutions).length === 0) {
        console.error('workspace-to-file: no resolutions in the root manifest — nothing to derive')
        process.exitCode = 1
        return false
    }
    if (pkg.overrides) {
        console.error('workspace-to-file: dropping an existing overrides block (mirrored from resolutions)')
    }
    const overrides = { ...pkg.resolutions }
    for (const [name, version] of Object.entries(BUN_FLATTEN)) {
        if (overrides[name] && overrides[name] !== version) {
            console.error(`workspace-to-file: refusing a bun flatten that re-points a resolutions entry (${name})`)
            process.exitCode = 1
            return false
        }
        overrides[name] = version
    }
    console.log(`workspace-to-file: bun store flatten: ${Object.entries(BUN_FLATTEN).map(([n, v]) => `${n}@${v}`).join(', ')}`)
    const canon = readBunCanon(targetRoot)
    if (canon) {
        let layered = 0
        for (const [name, version] of Object.entries(canon.pins)) {
            if (!(name in overrides)) {
                overrides[name] = version
                layered += 1
            }
        }
        console.log(`workspace-to-file: bun canon layered ${layered} extra pins \
(${canon.conflicts} multi-version names left to npm's own resolution)`)
    }
    for (const section of SECTIONS) {
        const deps = pkg[section]
        if (!deps) {
            continue
        }
        for (const name of Object.keys(deps)) {
            // a root dep whose name an override targets is npm EOVERRIDE —
            // BUT only when the override re-points it: an override that
            // re-states the dep's own exact version (the bun-canon layer
            // does that for thousands of direct pins) adds no redirect, and
            // deleting the entry would uninstall the dep: bare-root entries
            // like jsonwebtoken have no other importer in the workspace.
            if (name in overrides && overrides[name] !== deps[name]) {
                delete deps[name]
            }
        }
    }
    // turbo picks its package-manager binary from `packageManager`; the
    // npm-only build has no bun on the host (by design), so the derived
    // manifest must point it at npm. `packageManager` needs name@version and
    // process.versions no longer carries npm's version — ask the CLI, the
    // same binary `npm ci`/turbo will resolve from PATH.
    pkg.packageManager = `npm@${npmVersion().trim()}`
    pkg.overrides = overrides
    // The npmci-time approval also goes into the copy's .npmrc: the error
    // message for the install-time flag names BOTH places, and on some
    // in-between npm releases the field alone is not honored. The payload
    // still ships the repo's own .npmrc — the prebuild restores it over this
    // derived one before staging, same as the manifests.
    const npmrc = path.join(targetRoot, '.npmrc')
    const entry = `allow-scripts=${ALLOW_SCRIPTS.join(',')}`
    let lines = []
    if (fs.existsSync(npmrc)) {
        lines = fs.readFileSync(npmrc, 'utf8').split('\n')
    }
    if (!lines.some((line) => line.trim().startsWith('allow-scripts='))) {
        if (lines.length > 0 && lines.at(-1) !== '') {
            lines.push('')
        }
        lines.push('# derived for the npm build: approve native install-script builders')
        lines.push(entry)
        fs.writeFileSync(npmrc, `${lines.join('\n')}\n`)
        console.log('workspace-to-file: derived .npmrc (allow-scripts approvals)')
    }
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
    console.log(`workspace-to-file: derived npm root manifest (overrides: ${Object.keys(overrides).length})`)
    return true
}

const apply = ({ targetRoot }) => {
    // refuse to guess: a git checkout is the world this script must never
    // write (the operand is always the disposable build/source copy)
    if (fs.existsSync(path.join(targetRoot, '.git'))) {
        console.error(`workspace-to-file: ${targetRoot} looks like a git checkout — refusing; pass the disposable build/source copy`)
        process.exitCode = 1
        return
    }
    if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
        console.error(`workspace-to-file: no package.json under ${targetRoot} — refusing`)
        process.exitCode = 1
        return
    }
    if (deriveRoot(targetRoot) === false) {
        return
    }
    const rootPkg = readJson(path.join(targetRoot, 'package.json'))
    const byName = rebuildWorkspaceMap(targetRoot, rootPkg)
    const overrides = rootPkg.overrides ?? {}
    const counter = { aligned: 0 }

    let changed = 0
    for (const file of collectPackages(targetRoot, rootPkg)) {
        let pkg
        try {
            pkg = readJson(path.join(targetRoot, file))
        } catch (error) {
            console.error(`workspace-to-file: skipping unreadable ${file}: ${error.message}`)
            continue
        }
        let touched = false
        for (const section of SECTIONS) {
            const deps = pkg[section]
            if (!deps) {
                continue
            }
            for (const [name, spec] of Object.entries(deps)) {
                if (typeof spec !== 'string' || !spec.startsWith('workspace:')) {
                    continue
                }
                const memberDir = byName.get(name)
                if (!memberDir) {
                    console.error(`workspace-to-file: no workspace package named ${name} (referenced from ${file})`)
                    process.exitCode = 1
                    return
                }
                // npm accepts a bare relative path with an implicit file: —
                // keep the file: prefix explicit so npm<7-style parsing stays
                // unambiguous.
                const rel = path.posix.relative(path.posix.dirname(file), memberDir)
                deps[name] = rel.startsWith('.') ? `file:${rel}` : `file:./${rel}`
                touched = true
            }
            if (alignOverride({ deps, overrides, file, counter })) {
                touched = true
            }
        }
        if (touched) {
            fs.writeFileSync(path.join(targetRoot, file), `${JSON.stringify(pkg, null, 2)}\n`)
            changed += 1
            console.log(`workspace-to-file: derived ${file}`)
        }
    }
    if (counter.aligned > 0) {
        console.log(`workspace-to-file: aligned ${counter.aligned} member pins to overrides`)
    }
    console.log(`workspace-to-file: derived npm manifests (${changed} member files + root)`)
}

if (require.main === module) {
    const [mode, targetRoot] = process.argv.slice(2)
    if (mode === 'apply' && targetRoot) {
        apply({ targetRoot: path.resolve(targetRoot) })
    } else {
        console.error('usage: node scripts/workspace-to-file.cjs apply <targetRoot>')
        process.exitCode = 1
    }
}

module.exports = { apply }
