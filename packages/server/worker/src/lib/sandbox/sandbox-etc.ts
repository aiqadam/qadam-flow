import { chmod, mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isNil, tryCatch } from '@aiqadam/shared'
import writeFileAtomic from 'write-file-atomic'

// isolate mounts a directory as the sandbox's /etc, and the baked asset it used to mount pins
// Google DNS (8.8.8.8/8.8.4.4). That cannot resolve Docker Compose service names (`app`,
// `postgres`, `redis`) — they live only in Docker's embedded resolver at 127.0.0.11 — so a
// sandboxed engine process could not reach `AP_INTERNAL_URL` or any other compose service. The
// container's real resolv.conf is materialised into a directory of its own and mounted instead.
//
// Kept as a directory rather than a file mount because isolate's `--dir` only mounts directories.
const BAKED_ETC_DIR = path.resolve(process.cwd(), 'packages/server/api/src/assets/etc')
const BAKED_RESOLV_CONF_PATH = path.join(BAKED_ETC_DIR, 'resolv.conf')
const HOST_RESOLV_CONF_PATH = '/etc/resolv.conf'
const SANDBOX_ETC_DIR = path.join(os.tmpdir(), 'qadam-flow-sandbox-etc')
const RESOLV_CONF_NAME = 'resolv.conf'
const NAMESERVER_LINE = /^\s*nameserver\s+\S+/m

let materialized: Promise<string> | null = null

export const sandboxEtc = {
    // Idempotent per process: a container's resolver config does not change while it lives, so
    // every sandbox in this worker reuses the same directory.
    ensure: async (): Promise<string> => {
        const existing = materialized
        if (!isNil(existing)) {
            return existing
        }
        const building = materialize()
        materialized = building
        // A rejected materialisation must not be memoised, or every later sandbox in this process
        // fails with the same stale error until the worker restarts. Same shape as
        // `qadamDistIndex.get` (engine/src/lib/helper/qadam-dist-index.ts).
        void building.catch(() => {
            if (materialized === building) {
                materialized = null
            }
        })
        return building
    },
    // The resolver config the sandbox falls back to when the container has none of its own; the
    // egress lockdown unions its nameservers into the DNS allowlist so that fallback stays usable.
    fallbackResolvConfPath: (): string => BAKED_RESOLV_CONF_PATH,
}

async function materialize(): Promise<string> {
    const content = await readPreferredResolvConf()
    const resolvConfPath = path.join(SANDBOX_ETC_DIR, RESOLV_CONF_NAME)
    await mkdir(SANDBOX_ETC_DIR, { recursive: true, mode: 0o755 })
    await writeFileAtomic(resolvConfPath, content, { encoding: 'utf8', mode: 0o644 })
    // The sandbox runs as an isolate box UID, so a restrictive worker umask must not be allowed to
    // hide the directory or file from it; the baked asset this replaces was world-readable.
    await chmod(SANDBOX_ETC_DIR, 0o755)
    await chmod(resolvConfPath, 0o644)
    return SANDBOX_ETC_DIR
}

// Prefer the container's resolver so compose service names resolve; fall back to the baked asset
// when the host file is unreadable or carries no nameserver, which keeps the sandbox resolvable
// on a host whose /etc/resolv.conf is empty or absent.
async function readPreferredResolvConf(): Promise<string> {
    const host = await tryCatch(() => readFile(HOST_RESOLV_CONF_PATH, 'utf8'))
    if (isNil(host.error) && !isNil(host.data) && NAMESERVER_LINE.test(host.data)) {
        return host.data
    }
    const baked = await tryCatch(() => readFile(BAKED_RESOLV_CONF_PATH, 'utf8'))
    if (!isNil(baked.error)) {
        throw baked.error
    }
    if (isNil(baked.data) || !NAMESERVER_LINE.test(baked.data)) {
        throw new Error(`No usable nameserver in ${HOST_RESOLV_CONF_PATH} or ${BAKED_RESOLV_CONF_PATH}`)
    }
    return baked.data
}
