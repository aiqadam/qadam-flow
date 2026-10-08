import assert from 'node:assert'
import axios, { AxiosError } from 'axios'
import { readPackageJson } from './files'

// ADR-0001 gate 3: a version is never published twice, and the check reads the registry's
// VERSION LIST — not the `latest` dist-tag and not a diff against `origin/main`.
//
// What this replaced, and why each part was wrong (#783, #494 deliverable 1):
// - It asked for `<registry>/<pkg>/latest`, i.e. the `latest` dist-tag. A version published under
//   any other tag (a `beta`, an rc) is invisible there, so "is X published?" was answered "no" for
//   a published X, and the next run tried again and got npm's 403.
// - When the current version WAS `latest`, it diffed the package against `origin/main` to tell
//   "already published" from "changed but not bumped". On the publish path the checkout IS the tip
//   of main, so that diff was always empty and the "version not incremented" throw could never
//   fire there. Under ADR-0001 that question belongs to the PR, not to the publish: a changed
//   package without a changeset fails tools/ci/check-changesets.mjs (gate 1), and versions are
//   raised only by the release PR. So the publish path asks exactly one question now.
//
// Fail closed: a registry answer that is neither a 404 nor a packument with a `versions` object
// throws. "Could not tell" must never read as "not published" (a 403 at best, a publish over the
// wrong state at worst) nor as "published" (a silently skipped release).
export const packagePrePublishChecks = async ({ path, registryUrl = NPM_REGISTRY_URL, maxAttempts = 5, retryBaseMs = 2000 }: PackagePrePublishChecksParams): Promise<boolean> => {
  assert(path, '[packagePrePublishChecks] parameter "path" is required')
  const { name, version } = await readPackageJson(path)
  assert(typeof name === 'string' && name.length > 0, `[packagePrePublishChecks] ${path}/package.json has no name`)
  assert(typeof version === 'string' && version.length > 0, `[packagePrePublishChecks] ${path}/package.json has no version`)

  const published = await fetchPublishedVersions({ packageName: name, registryUrl, maxAttempts, retryBaseMs })
  if (published === null) {
    console.info(`[packagePrePublishChecks] ${name} is not on the registry yet; ${version} will be published`)
    return false
  }
  if (published.has(version)) {
    console.info(`[packagePrePublishChecks] ${name}@${version} is already in the registry's version list; skipping`)
    return true
  }
  console.info(`[packagePrePublishChecks] ${name}@${version} is not among ${published.size} published version(s); it will be published`)
  return false
}

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'
const REQUEST_TIMEOUT_MS = 30_000

// `null` when the registry has never heard of the package (404); otherwise every published
// version, whatever dist-tag it went out under.
const fetchPublishedVersions = async ({ packageName, registryUrl, maxAttempts, retryBaseMs }: FetchPublishedVersionsParams): Promise<Set<string> | null> => {
  const url = `${registryUrl.replace(/\/+$/, '')}/${packageName.replace('/', '%2f')}`
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.get<unknown>(url, {
        timeout: REQUEST_TIMEOUT_MS,
        // The abbreviated ("corgi") document npm itself installs from: it carries the version
        // list and nothing heavy.
        headers: { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
      })
      return readVersionList({ packageName, body: response.data })
    }
    catch (e: unknown) {
      if (e instanceof AxiosError && e.response?.status === 404) {
        return null
      }
      if (!isRetryable({ error: e }) || attempt >= maxAttempts) {
        throw new Error(`[packagePrePublishChecks] could not read the version list of ${packageName} from ${url} (attempt ${attempt}/${maxAttempts}): ${describe({ error: e })}`)
      }
      const delay = Math.pow(4, attempt - 1) * retryBaseMs
      console.warn(`[packagePrePublishChecks] ${packageName}: attempt ${attempt} failed (${describe({ error: e })}); retrying in ${delay} ms`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function readVersionList({ packageName, body }: { packageName: string, body: unknown }): Set<string> {
  const versions = isRecord(body) ? body.versions : undefined
  if (!isRecord(versions)) {
    throw new Error(`[packagePrePublishChecks] the registry answered for ${packageName} without a "versions" object — refusing to guess whether it is published`)
  }
  return new Set(Object.keys(versions))
}

// Network failures, timeouts, 429 and 5xx are worth another attempt; any other status (401, 403,
// a 3xx the client did not follow) is an answer, and retrying it only delays the failure.
function isRetryable({ error }: { error: unknown }): boolean {
  if (!(error instanceof AxiosError)) {
    return false
  }
  const status = error.response?.status
  return status === undefined || status === 429 || status >= 500
}

function describe({ error }: { error: unknown }): string {
  if (error instanceof AxiosError) {
    return error.response ? `HTTP ${error.response.status}` : (error.code ?? error.message)
  }
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type PackagePrePublishChecksParams = {
  path: string
  // Overridable for tools/ci/test-registry-version-gate.sh, which runs this against a local stub
  // registry. Every production caller uses the default.
  registryUrl?: string
  maxAttempts?: number
  retryBaseMs?: number
}

type FetchPublishedVersionsParams = {
  packageName: string
  registryUrl: string
  maxAttempts: number
  retryBaseMs: number
}
