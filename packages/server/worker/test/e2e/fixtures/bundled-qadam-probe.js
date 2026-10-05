/* eslint-disable @typescript-eslint/no-require-imports */
// Probe that reports the sandbox's resolver config and tries to load a bundled qadam the
// way the engine's loader does — a bare `require()` of the resolved dist path, which then
// resolves @aiqadam/qadams-framework, @aiqadam/shared and third-party deps through the
// package symlink farms. Exercises the mounts create-sandbox-for-job adds for isolate modes.

const fs = require('node:fs')

function main() {
    const result = { resolvConf: null, qadamLoaded: false, qadamKeys: [], error: null }
    try {
        result.resolvConf = fs.readFileSync('/etc/resolv.conf', 'utf8')
    }
    catch (err) {
        result.error = `resolv.conf: ${String(err && err.message || err)}`
    }
    try {
        const mod = require(process.env.AP_PROBE_QADAM_PATH)
        result.qadamLoaded = true
        result.qadamKeys = Object.keys(mod)
    }
    catch (err) {
        result.error = String(err && err.message || err)
    }
    process.stdout.write(JSON.stringify(result))
}

main()
