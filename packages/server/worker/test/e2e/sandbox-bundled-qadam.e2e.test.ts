import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { bundledQadamsMounts } from '../../src/lib/execute/create-sandbox-for-job'
import { getIsolateExecutableName, isolateProcess } from '../../src/lib/sandbox/isolate'
import { requireIsolateBinary, requireLinuxPrivileged } from './helpers/privilege-guard'
import { silentLogger } from './helpers/silent-logger'

/**
 * #375 defect 3: isolate starts the engine with cwd=/root, so the engine resolves bundled qadams
 * under /root/packages/qadams — which nothing mounted, so every bundled qadam failed with
 * QadamNotFoundError. `bundledQadamsMounts` adds the qadam tree, packages/shared and
 * node_modules/.bun at the same relative paths; this boots isolate with exactly those mounts and
 * loads a real built qadam the way the engine's loader does.
 *
 * #375 defect 2: the sandbox used to mount the baked resolv.conf (8.8.8.8), which cannot resolve
 * Docker Compose service names. It now mounts the container's own /etc/resolv.conf.
 */

const BOX_ID = 0
const ISOLATE_BINARY_PATH = path.resolve(process.cwd(), 'packages/server/api/src/assets', getIsolateExecutableName())
const BUNDLED_QADAM_PATH = path.resolve(process.cwd(), 'packages/qadams/core/webhook/dist/src/index.js')
const SANDBOX_QADAM_PATH = '/root/packages/qadams/core/webhook/dist/src/index.js'
const BAKED_RESOLV_CONF_PATH = path.resolve(process.cwd(), 'packages/server/api/src/assets/etc/resolv.conf')

const skip = requireLinuxPrivileged() ?? requireIsolateBinary(ISOLATE_BINARY_PATH)

describe.skipIf(skip)('sandbox bundled qadams + resolver — isolate mounts', () => {
    let commonDir: string
    let probeResult: ProbeResult | null = null

    beforeAll(async () => {
        if (!existsSync(BUNDLED_QADAM_PATH)) {
            throw new Error(
                `precondition failed: ${BUNDLED_QADAM_PATH} is not built. The sandbox e2e image builds ` +
                '@aiqadam/qadam-webhook and its workspace deps; run the suite via `npm run test:sandbox-e2e`.',
            )
        }

        commonDir = await mkdtemp(path.join(tmpdir(), 'ap-bundled-qadam-'))
        const probeDst = path.join(commonDir, 'bundled-qadam-probe.js')
        await copyFile(path.resolve(__dirname, 'fixtures/bundled-qadam-probe.js'), probeDst)
        await chmod(commonDir, 0o755)
        await chmod(probeDst, 0o644)

        probeResult = await runProbeInSandbox({ commonDir })
    }, 60_000)

    it('loads a bundled qadam inside the isolate sandbox through the mounted package trees', () => {
        expect(probeResult!.error).toBeNull()
        expect(probeResult!.qadamLoaded).toBe(true)
        expect(probeResult!.qadamKeys).toContain('webhook')
    })

    it('gives the sandbox the container\'s own resolv.conf, not the baked Google-DNS asset', async () => {
        const hostResolvConf = await readFile('/etc/resolv.conf', 'utf8')
        const bakedResolvConf = await readFile(BAKED_RESOLV_CONF_PATH, 'utf8')

        expect(probeResult!.resolvConf).toBe(hostResolvConf)
        expect(probeResult!.resolvConf).not.toBe(bakedResolvConf)
    })
})

async function runProbeInSandbox({ commonDir }: { commonDir: string }): Promise<ProbeResult> {
    const logger = silentLogger()
    const maker = isolateProcess(logger, path.join(commonDir, 'bundled-qadam-probe.js'), commonDir, BOX_ID)

    const child = await maker.create({
        sandboxId: 'e2e-bundled-qadam',
        command: [],
        mounts: [
            { hostPath: commonDir, sandboxPath: '/root/common' },
            ...bundledQadamsMounts({ executionMode: 'SANDBOX_PROCESS' }),
        ],
        env: {
            HOME: '/tmp/',
            NODE_PATH: '/usr/src/node_modules',
            AP_EXECUTION_MODE: 'SANDBOX_PROCESS',
            AP_SANDBOX_WS_PORT: '0',
            AP_SANDBOX_WS_TOKEN: 'e2e-sandbox-token',
            AP_BASE_CODE_DIRECTORY: '/root/codes',
            SANDBOX_ID: 'e2e-bundled-qadam',
            AP_PROBE_QADAM_PATH: SANDBOX_QADAM_PATH,
        },
        resourceLimits: { memoryLimitMb: 512, cpuMsPerSec: 1000, timeLimitSeconds: 30 },
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.removeAllListeners('data')
    child.stderr?.removeAllListeners('data')
    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d))
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d))

    const exitCode = await new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))

    const out = Buffer.concat(stdoutChunks).toString().trim()
    const err = Buffer.concat(stderrChunks).toString().trim()
    const jsonLine = out.split('\n').reverse().find((line) => line.trim().startsWith('{'))
    if (!jsonLine) throw new Error(`No JSON on probe stdout (exit=${exitCode}). stdout="${out}" stderr="${err}"`)
    return JSON.parse(jsonLine) as ProbeResult
}

type ProbeResult = {
    resolvConf: string | null
    qadamLoaded: boolean
    qadamKeys: string[]
    error: string | null
}
