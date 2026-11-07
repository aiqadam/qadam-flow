#!/usr/bin/env node
/**
 * debian-lock-repair.cjs — correctness gate for the npm lockfile the deb
 * pipeline installs from.
 *
 * Two failure modes of npm's `--package-lock-only` regen have been observed
 * on this tree, and both break a later `npm ci` or the vendored runtime:
 *
 *   1. EMPTY placeholder nodes — npm writes `{}` for a nested node it
 *      deduped mid-placement (observed: ai-gateway-provider under
 *      packages/qadams/community/ai). `npm ci` builds its ideal tree from
 *      the lock, treats the version-less node as real and aborts inside
 *      arborist's canDedupe with "Invalid Version: ". The entries carry no
 *      data, so dropping them is lossless for the tree the lock describes.
 *   2. DANGLING runtime deps — a dependent's `dependencies` records a spec
 *      but NO node anywhere in the lock satisfies it (observed: arrify
 *      ^2.0.0, declared only by the google-auth-library@8.9.0 nested under
 *      packages/qadams/community/gcloud-pubsub — its node never landed, the
 *      empty placeholder that carried it got dropped, `npm ci` reproduced
 *      the gap faithfully and the vendored tree failed require('arrify') at
 *      manifest-load time).
 *
 * The repair is package-agnostic:
 *   1. drop empty placeholder nodes;
 *   2. re-resolve every remaining node's declared runtime dependencies
 *      (not optional, not peer) against the path-keyed lock tree using
 *      node.js' real directory-ascent rule;
 *   3. for names nothing satisfies, resolve them once through a throw-away
 *      fixture project (build/lockfix-*) and graft the resulting lock nodes
 *      at the tree root — the exact version comes from the root `overrides`
 *      map when the derivation pinned one, otherwise from the edge spec.
 *
 * Idempotent: a second run finds nothing to do and rewrites nothing.
 *
 * usage: node debian-lock-repair.cjs <source-copy-dir> <build-dir>
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const SRC = path.resolve(process.argv[2] || '.')
const BUILD = path.resolve(process.argv[3] || path.join(SRC, '..'))
const LOCK = path.join(SRC, 'package-lock.json')

const rootPkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
const rootOverrides = rootPkg.overrides ?? {}
const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
const packages = lock.packages ?? {}
if (!packages || typeof packages !== 'object') throw new Error('lock has no packages table')

const realSemver = (() => {
    try {
        return require(require.resolve('semver', { paths: [path.join(SRC, 'node_modules')] }))
    } catch {
        return null
    }
})()

function looseSatisfies (spec, version) {
    const s = String(spec).trim()
    if (s === '' || s === '*' || s === 'x' || s === 'latest' || s.startsWith('npm:')) return true
    const v = String(version).replace(/-[0-9A-Za-z.-]*$/, '').split('.').map((n) => parseInt(n, 10) || 0)
    const m = s.match(/^([\^~]?)([0-9]+(?:\.[0-9]+)*)$/)
    if (!m) return true
    const c = m[2].split('.').map((n) => parseInt(n, 10) || 0)
    const compare = [0, 1, 2].reduce((acc, i) => acc || ((v[i] || 0) !== (c[i] || 0) ? (v[i] || 0) > (c[i] || 0) ? 1 : -1 : 0), 0)
    const ge = compare >= 0
    const eq = compare === 0
    if (m[1] === '^') return (v[0] || 0) === (c[0] || 0) && ge
    if (m[1] === '~') return (v[0] || 0) === (c[0] || 0) && (v[1] || 0) === (c[1] || 0) && ge
    return eq
}

const satisfies = (version, spec) =>
    realSemver
        ? realSemver.satisfies(version, String(spec), { includePrerelease: true })
        : looseSatisfies(spec, version)

// node.js require() ascent from a package directory: its own node_modules
// first, then every ancestor directory's node_modules, up to and including
// the tree root.
function candidates (dependent, name) {
    const parts = dependent.split('/')
    const out = []
    for (let i = parts.length; i >= 0; i--) {
        const base = parts.slice(0, i).join('/')
        out.push(base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`)
    }
    return [...new Set(out)]
}

function resolvedBy (name, spec, fromKey) {
    // Root overrides rewrite the effective spec npm resolved everywhere,
    // and workspace links resolve through the link itself — both are
    // legitimate resolutions the declared edge spec alone cannot see; so
    // are npm: alias edges, whose compatibility npm settled at regen time.
    const eff = rootOverrides[name] ?? spec
    const alias = /\bnpm:/.test(eff)
    for (const cand of candidates(fromKey, name)) {
        const node = packages[cand]
        if (!node) continue
        if (node.link) return cand
        if (typeof node.version !== 'string') continue
        if (alias) return cand
        if (satisfies(node.version, eff)) return cand
    }
    return null
}

let dirty = false

// 1. drop empty placeholder nodes
const ghosts = []
for (const [k, v] of Object.entries(packages)) {
    if (v && Object.keys(v).length === 0) ghosts.push(k)
}
if (ghosts.length > 0) {
    for (const k of ghosts) delete packages[k]
    dirty = true
    console.log(`[lock-repair] dropped ${ghosts.length} empty placeholder node(s): ${ghosts.join(', ')}`)
}

// 2+3. audit-fixpoint: re-resolve every declared runtime dependency against
// the tree; graft what nothing satisfies through a throw-away fixture.
// A graft can itself introduce fresh dependencies, so the audit repeats
// until the tree settles (bounded — every pass strictly removes names).
for (let pass = 1; pass <= 6; pass++) {
    const dangling = new Map()
    for (const [key, node] of Object.entries(packages)) {
        if (!node || node.link) continue
        const deps = node.dependencies
        if (!deps || typeof deps !== 'object') continue
        for (const [name, spec] of Object.entries(deps)) {
            if (typeof spec !== 'string' || spec === '') continue
            if (!resolvedBy(name, spec, key)) {
                const edges = dangling.get(name) ?? []
                edges.push({ from: key, spec })
                dangling.set(name, edges)
            }
        }
    }
    if (dangling.size === 0) {
        console.log(`[lock-repair] pass ${pass}: audit clean — all declared dependencies resolve`)
        break
    }
    if (pass === 6) {
        throw new Error('lock audit did not settle in 5 fill passes: ' + [...dangling.keys()].join(', '))
    }
    console.log(`[lock-repair] pass ${pass}: ${dangling.size} unplaced name(s)`)

    const fixture = fs.mkdtempSync(path.join(BUILD, 'lockfix-'))
    try {
        const want = []
        for (const [name, edges] of dangling) {
            const pin = typeof rootOverrides[name] === 'string' ? rootOverrides[name] : null
            const spec = pin && pin !== '' ? pin : edges[0].spec
            if (pin && pin !== edges[0].spec) {
                console.log(`[lock-repair] ${name}: override pin ${pin} replaces edge spec ${edges[0].spec} (${edges.length} edge(s))`)
            }
            want.push([name, spec])
        }
        fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
            name: 'lockfix',
            version: '0.0.0',
            private: true,
            dependencies: Object.fromEntries(want),
        }, null, 2))
        console.log(`[lock-repair] resolving ${want.length} unplaced name(s): ${want.map(([n, s]) => `${n}@${s}`).join(', ')}`)
        execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-fund', '--no-audit', '--legacy-peer-deps'], {
            cwd: fixture,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 300000,
        })
        const fx = JSON.parse(fs.readFileSync(path.join(fixture, 'package-lock.json'), 'utf8'))
        for (const [name, spec] of want) {
            const node = fx.packages?.[`node_modules/${name}`]
            if (!node || typeof node.version !== 'string') {
                throw new Error(`fixture did not resolve ${name}@${spec}`)
            }
            packages[`node_modules/${name}`] = node
            dirty = true
            console.log(`[lock-repair] filled node_modules/${name}@${node.version} (spec ${spec})`)
        }
    } finally {
        fs.rmSync(fixture, { recursive: true, force: true })
    }
}

if (!dirty) {
    console.log('[lock-repair] lock consistent — nothing to do')
    process.exit(0)
}
fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n')
console.log(`[lock-repair] wrote repaired ${path.relative(path.dirname(path.dirname(LOCK)), LOCK)}`)
