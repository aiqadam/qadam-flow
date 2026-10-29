#!/usr/bin/env node
/**
 * Bridge between bun's per-package node_modules layout and npm's hoisted one
 * for the deb build copy (run by scripts/debian-prebuild.sh, AFTER the copy is
 * ci-installed — see the copy-out rule in workspace-to-file.cjs).
 *
 * Why: workspace member tsconfigs may map a deep module to types inside a
 * PACKAGE-LOCAL node_modules (`"./node_modules/<name>/..."` paths entries) —
 * bun writes those node_modules directories for every member's direct deps,
 * while npm hoists single-version packages to the root and creates no local
 * directory, so such a tsconfig mapping silently breaks under npm. This scans
 * every tsconfig*.json in the target tree for the pattern, links the hoisted
 * package into the member's node_modules, and verifies every mapped file
 * resolves inside it. Fail-closed: a mapping whose file cannot be produced is
 * a type error the build would hit later anyway — surfaced here with a clear
 * message instead.
 *
 *   node scripts/debian-tsconfig-paths.cjs <targetRoot>
 */
'use strict'

const fs = require('fs')
const path = require('path')

const collect = (dir, depth = 0) => {
    if (depth > 8) return []
    let entries
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
        return []
    }
    const found = []
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            found.push(...collect(full, depth + 1))
        } else if (/^tsconfig.*\.json$/.test(entry.name)) {
            found.push(full)
        }
    }
    return found
}

const apply = (targetRoot) => {
    const hoistedRoot = path.join(targetRoot, 'node_modules')
    let links = 0
    for (const cfgFile of collect(targetRoot)) {
        let cfg
        try {
            cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
        } catch {
            continue
        }
        const paths = cfg?.compilerOptions?.paths ?? {}
        const pkgDir = path.dirname(cfgFile)
        for (const targets of Object.values(paths)) {
            for (const target of targets ?? []) {
                const match = /^(?:\.\/)?node_modules\/([^/\\\\]+(?:\/[^/\\\\]+)?)\/(.+)$/.exec(target)
                if (!match) continue
                const [, name, mappedFile] = match
                const hoisted = path.join(hoistedRoot, name)
                if (!fs.existsSync(hoisted)) continue
                const local = path.join(pkgDir, 'node_modules', name)
                let resolved
                if (fs.existsSync(local)) {
                    resolved = path.join(fs.realpathSync(local), mappedFile)
                } else {
                    fs.mkdirSync(path.dirname(local), { recursive: true })
                    fs.symlinkSync(hoisted, local, 'dir')
                    links += 1
                    resolved = path.join(hoisted, mappedFile)
                }
                if (!fs.existsSync(resolved)) {
                    console.error(`debian-tsconfig-paths: ${cfgFile} paths entry "${target}" ` +
                        `does not resolve (missing file under ${resolved})`)
                    process.exitCode = 1
                    console.error('debian-tsconfig-paths: FAIL-closed — fix the mapping or ship the file')
                    return
                }
            }
        }
    }
    console.log(`debian-tsconfig-paths: ${links} package-local node_modules link(s), all mapped files verified`)
}

const targetRoot = process.argv[2]
if (!targetRoot) {
    console.error('debian-tsconfig-paths: usage: debian-tsconfig-paths.cjs <targetRoot>')
    process.exitCode = 1
} else {
    apply(path.resolve(targetRoot))
}
