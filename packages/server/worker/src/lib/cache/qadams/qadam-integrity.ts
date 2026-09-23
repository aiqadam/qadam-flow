import { createPublicKey, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { safeHttp } from '@aiqadam/server-utils'
import { isNil, OFFICIAL_QADAM_SCOPE_PREFIX, partition, QadamPackage, QadamType, tryCatch, tryCatchSync } from '@aiqadam/shared'
import { parse as parseJsonc } from 'jsonc-parser'
import { Logger } from 'pino'

// #482 item 4. The issue asks for `--frozen-lockfile` or "integrity pinning" over the official
// set, because those package names are not chosen by any administrator and so nobody is in the
// loop to notice a substitution. Neither of the two shapes the issue names works here, and the
// reasons are worth keeping next to the code that replaced them:
//
//   * `--frozen-lockfile` needs a checked-in lockfile. This workspace has none and gains qadams
//     incrementally, so freezing would fail every install that adds one.
//   * A manifest of `name@version -> sha512` built from the image can only cover versions that
//     existed when the image was built. An OFFICIAL qadam's version is resolved from the
//     database plus the bundled catalogue (`qadam-metadata-service.ts`), and a database row can
//     have been written by a NEWER image — which is the entire point of step 2, letting qadam
//     versions move independently of the image. Failing closed on an unlisted version would veto
//     that; skipping an unlisted version would protect nothing, since a compromised publish
//     presents as exactly that.
//
// What does work is a binding that needs no advance knowledge of the version. bun verifies the
// tarball it downloads against the integrity it records in `bun.lock`; npmjs signs the pair
// `<name>@<version>:<integrity>`. Checking npmjs's signature over the integrity BUN ITSELF
// ENFORCED closes the loop: a mirror or proxy that served different bytes produces a different
// integrity, and cannot produce a signature over it.
//
// Two limits on that claim, both narrower than they first read. bun hashes a tarball when it
// DOWNLOADS it; a version already extracted in bun's global install cache is reused without
// re-hashing, so the guarantee is "npmjs signed these bytes when bun first fetched them into
// this cache", not "these bytes are on disk right now". Tampering with the tree after install is
// out of scope for the same reason. And a valid signature says npmjs attested the bytes, not
// that WE published them — that would be the Sigstore provenance in `dist.attestations`, which
// is available hardening rather than something this does.
//
// Note what is deliberately NOT used: `npm audit signatures`. It is already in the image and it
// runs in this workspace, but it verifies the registry's signature over the registry's own
// integrity and never hashes the installed tree — measured directly, it exits 0 on a tree whose
// bytes were modified after install. It answers "does the registry vouch for a package by this
// name and version", which is not the question this guard exists to ask.
export const qadamIntegrity = (log: Logger) => ({
    // Throws on the first official-scope package whose integrity npmjs has not signed. The caller
    // rolls the installation back, the same as it does for a failed `bun install` — a package
    // that cannot be shown to be ours must not be marked usable, and must not be left where the
    // engine's loader would resolve it in preference to the bundled build.
    //
    // Called ONCE per install, never per qadam. bun resolves every workspace member regardless of
    // `--filter` (measured on bun 1.3.11 — note the runtime image pins 1.3.1 and CI 1.3.3, so
    // this is a measurement on a NEWER bun than we ship; `assertBatchIsCovered` is what stops it
    // from being load-bearing), so even a filtered install writes lockfile entries for
    // packages outside the filter — running this inside the per-qadam fallback loop made one
    // unverifiable entry roll back every other qadam in the batch, and blame the wrong one.
    async verifyOfficialQadams({ rootWorkspace, installed, refusedBeforeInstall }: {
        rootWorkspace: string
        installed: QadamPackage[]
        refusedBeforeInstall: Set<string>
    }): Promise<void> {
        const { resolved, refusals } = await readOfficialQadamsFromLockfile({ rootWorkspace })
        reportRefusals({ refusals, installed, refusedBeforeInstall, log })
        assertBatchIsCovered({ resolved, installed })

        // Deduplicated, not just filtered: the same official package can appear at two tree
        // positions, and each copy would otherwise buy its own registry read. The serial loop
        // below exists precisely to keep this pass off the registry's rate limiter, so reading one
        // version document twice is the request it is shaped to avoid — and `count` in the log
        // would overstate the work for the same reason.
        const notYetVerified = resolved.filter((pkg) => !verifiedPackages.has(cacheKey(pkg)))
        const unverified = uniqueByCacheKey(notYetVerified)
        if (unverified.length === 0) {
            return
        }

        log.info({
            rootWorkspace,
            count: unverified.length,
            // Against the filtered-but-undeduped array, not `resolved`: a second tree position for
            // a package nothing has verified is not an already-verified package.
            alreadyVerified: resolved.length - notYetVerified.length,
        }, '[qadamIntegrity] verifying registry signatures for official qadams')

        // Serially rather than in parallel. This runs inside the installer's file lock, on a set
        // that is normally a handful of packages, and a burst of registry requests from every
        // worker replica coming out of a cold cache at once is the shape that earns a 429.
        //
        // Serial and unbounded would be a different thing though, so the whole pass shares one
        // deadline rather than only bounding each request — see VERIFICATION_BUDGET_MS.
        const deadline = Date.now() + VERIFICATION_BUDGET_MS
        for (const pkg of unverified) {
            await verifySignature({ pkg, deadline, log })
            verifiedPackages.add(cacheKey(pkg))
        }
    },

    // The lockfile keys that were ALREADY unverifiable before this install ran — see
    // `reportRefusals` for what the difference is used for. Takes the lockfile's CONTENTS rather
    // than reading it, because the installer must snapshot the same bytes it classifies: it
    // restores them if this install is abandoned, and a second read could not be shown to have
    // seen the same file.
    //
    // Never throws, unlike every other read in this file. A missing, empty or unparseable lockfile
    // before an install is the ordinary first-install case, and treating it as "nothing was refused
    // before" is the conservative reading: every refusal the post-install pass then finds counts
    // as introduced by this install, and fails it closed.
    refusedKeysIn({ lockfileContents }: { lockfileContents: string | undefined }): Set<string> {
        if (isNil(lockfileContents)) {
            return new Set()
        }
        const { data, error } = tryCatchSync(() => collectOfficialEntries(parseLockfile(lockfileContents)))
        if (!isNil(error) || isNil(data)) {
            return new Set()
        }
        return new Set(data.refusals.map((refusal) => refusal.key))
    },
})

// npmjs's package-signing public keys, pinned rather than fetched.
//
// `npm audit signatures` reads these from `/-/npm/v1/keys` on the registry it is verifying, which
// is circular against the threat #482 actually names: an internal mirror or a transparently
// rewriting proxy serves its own key alongside its own matching signature and the check passes.
// Pinning is the whole reason this verification means anything.
//
// The cost of pinning is that an npmjs key rotation stops official qadam installs until the image
// carries the new key. That is accepted rather than softened: falling back to "unknown key id, so
// allow it" would hand an attacker the trivial bypass. The escape hatch already exists and needs
// no new knob — `OFFICIAL_QADAMS_INSTALL_ENABLED=false` returns the deployment to the qadams
// compiled into the image, and is also what gates this check running at all.
//
// Refresh procedure: `curl https://registry.npmjs.org/-/npm/v1/keys` and add any new non-expired
// entry here, keeping the outgoing one until it is gone from that response. Entries npm marks
// with an `expires` date are deliberately NOT carried: a signature made by a key that has since
// expired is not evidence this guard should accept.
const NPM_SIGNING_KEYS: Record<string, string> = {
    'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
}

// Only the official scope (`OFFICIAL_QADAM_SCOPE_PREFIX`, shared with the API's registration
// check). A community qadam's third-party dependencies resolve through the same install and many
// of them are unsigned — older packages predate npm's signing entirely — so extending this to the
// whole graph would fail installs that work today. It is also not what #482 asks for: the threat
// it names is names no administrator chose.
//
// `qadam-installer.ts` carries its own `OFFICIAL_QADAM_REGISTRY_URL`, written into the install
// workspace's `.npmrc`; this one is joined with path segments to read version documents. #478
// makes the registry configurable and will have to change BOTH.
const OFFICIAL_QADAM_REGISTRY_URL = 'https://registry.npmjs.org'
// A registry entry in bun's text lockfile is `[spec, registry, dependencies, integrity]`. The
// other arities are not variations to tolerate — see `classifyEntry`.
const LOCKFILE_REGISTRY_ENTRY_ARITY = 4
const LOCKFILE_WORKSPACE_ENTRY_ARITY = 1
const LOCKFILE_NAME = 'bun.lock'
// `safeHttp.retryingAxios` sets no timeout, and this call runs inside a lock every other worker
// replica is waiting on: a connection that establishes and then goes silent would hang the install
// until the lock holder died, which — since the holder refreshes the lock — is never.
const REGISTRY_TIMEOUT_MS = 30_000
// `safeHttp.retryingAxios` retries 5xx and nothing else. A 429 on the READ side is the very
// failure the serial loop above is written to avoid provoking, so leaving it unhandled would mean
// the anticipated case fails the install outright.
const REGISTRY_RATE_LIMIT_ATTEMPTS = 4
const REGISTRY_RATE_LIMIT_BACKOFF_MS = 2_000
const HTTP_TOO_MANY_REQUESTS = 429
// One budget for the WHOLE pass, not just per request, because the per-request bound multiplies:
// the first install after a worker process restart re-verifies everything (`verifiedPackages` is
// process-local), which with the official catalogue installed is a few hundred sequential reads,
// each able to spend REGISTRY_TIMEOUT_MS plus its 429 backoffs. All of that happens inside
// `fileLock.runExclusive`, and `proper-lockfile` refreshes the lock's mtime while it is held — so
// the 5-minute stale window never expires under a live holder and the hold is genuinely unbounded
// without this.
//
// What the per-request timeout does and does not cover, since review disagreed on it and the
// answer decides this number: axios-retry's own 5xx retries are INSIDE the one timeout, not
// multiplied by it. `shouldResetTimeout` defaults to false and `handleRetry` subtracts the last
// attempt's duration AND the retry delay from `config.timeout`, rejecting once that goes
// non-positive (axios-retry 4.4.1, `dist/cjs/index.js`), and `safe-http.ts` does not override it.
// So the only thing that can overrun the per-request bound is OUR 429 backoff, which is why the
// sleep below is clamped to the deadline too.
//
// 150s is chosen against the WAITERS, not against the happy path: `fileLock` retries 100 times
// with a 2s cap — ≈177s summed — so a replica queued behind this gives up at roughly that.
// Releasing first means a pathological registry fails the one install holding the lock, which is
// retried, instead of failing that one AND every replica waiting on it. What this number does NOT
// do is keep the whole hold under the waiter budget: the lock also covers `bun install`, whose own
// timeout is 10 minutes (`bun-runner.ts`), so a slow install blows past every waiter with or
// without this pass. 150s is chosen only so that verification does not ADD to that. The
// happy path is far under: a few hundred cached-DNS GETs to registry.npmjs.org run in tens of
// seconds, and only the first install per process pays even that.
const VERIFICATION_BUDGET_MS = 150_000

// Keyed on the triple, not on `name@version`: if the same version ever resolves to a different
// integrity, that is precisely the event this guard exists to catch, and a cache keyed on the
// version alone would answer it from memory.
const verifiedPackages = new Set<string>()

const cacheKey = ({ name, version, integrity }: ResolvedPackage): string => `${name}@${version}:${integrity}`

function uniqueByCacheKey(packages: ResolvedPackage[]): ResolvedPackage[] {
    return [...new Map(packages.map((pkg) => [cacheKey(pkg), pkg])).values()]
}

// `bun.lock` is JSONC — bun writes trailing commas, so `JSON.parse` rejects it outright.
//
// The whole workspace is read, not just the batch that triggered this install, because a filtered
// `bun install` resolves every workspace member anyway: entries for packages outside `--filter`
// are present from the first install onwards (measured on bun 1.3.11; the image pins 1.3.1 and
// CI 1.3.3, and `assertBatchIsCovered` turns this from an assumption into a check). The cache above
// is what keeps that from re-checking the same packages on every install. An earlier version of
// this comment claimed the lockfile is never pruned; that is wrong — removing a workspace member
// and re-installing does drop its entries — and the difference matters, because it means a
// rejected qadam does not permanently poison the shared workspace.
const readOfficialQadamsFromLockfile = async ({ rootWorkspace }: { rootWorkspace: string }): Promise<LockfileReading> => {
    const lockfilePath = join(rootWorkspace, LOCKFILE_NAME)
    const { data: contents, error } = await tryCatch(async () => readFile(lockfilePath, 'utf8'))
    if (!isNil(error) || isNil(contents)) {
        // Reached only after a SUCCESSFUL `bun install`, which always writes a lockfile. Its
        // absence means nothing can be established about what landed on disk, and the one thing
        // this guard must not do is let an unverifiable official package be marked usable.
        throw new Error(`[qadamIntegrity] cannot verify official qadams: ${LOCKFILE_NAME} is unreadable at ${lockfilePath}`)
    }

    return collectOfficialEntries(parseLockfile(contents))
}

const parseLockfile = (contents: string): unknown => {
    const parseErrors: { error: number, offset: number, length: number }[] = []
    const lockfile: unknown = parseJsonc(contents, parseErrors, { allowTrailingComma: true })
    if (parseErrors.length > 0) {
        throw new Error(`[qadamIntegrity] cannot verify official qadams: ${LOCKFILE_NAME} did not parse (${parseErrors.length} error(s))`)
    }
    return lockfile
}

const collectOfficialEntries = (lockfile: unknown): LockfileReading => {
    const packages = readProperty({ source: lockfile, key: 'packages' })
    if (!isRecord(packages)) {
        throw new Error(`[qadamIntegrity] cannot verify official qadams: ${LOCKFILE_NAME} has no packages map`)
    }
    const classified = Object.entries(packages).flatMap(([key, entry]) => {
        const result = classifyEntry({ key, entry })
        return isNil(result) ? [] : [result]
    })
    return {
        resolved: classified.filter((entry): entry is ResolvedPackage => !('reason' in entry)),
        refusals: classified.filter((entry): entry is Refusal => 'reason' in entry),
    }
}

// A refusal is fatal for the install that INTRODUCED it, and only for that one.
//
// The check reads the WHOLE workspace lockfile — it has to, because bun resolves every workspace
// member regardless of `--filter` — but the workspace is shared by every tenant on this worker
// (`getCustomPiecesPath` returns the common cache in the default UNSANDBOXED mode). Throwing on
// any refusal anywhere therefore had a failure mode both reviewers found independently: one
// platform registers a CUSTOM ARCHIVE qadam under an `@aiqadam/` name — refused by the API since
// #503, but a row registered before that, or an API still on an older image, can still reach a
// worker — which writes a tarball entry under an official-scope key. Every later install into that workspace then threw, for every
// tenant, forever, and the rollback removed the innocent current batch while the offending entry
// (whose own directory is still there, so bun does not prune it) stayed put.
//
// Throwing bought nothing in that case. An entry that was already refused before this install ran
// shadows an official name whether or not THIS install proceeds, so failing this batch neither
// removes it nor protects the packages this batch is installing. It is logged, named, and given
// the remedy instead.
//
// "Already there" is established by reading the lockfile before `bun install`, not inferred from
// the batch's names. The first spelling of this compared a refusal's name against the batch
// members and called everything else pre-existing, which is a different and weaker claim: an
// official-scope alias pulled in as a TRANSITIVE dependency of a qadam being installed right now
// carries a name no batch member has, so this install introduced it and the old rule waved it
// through. Two conditions fail closed, therefore, and the second is not implied by the first:
//
//   * the refusal's lockfile key was not refused before this install — this install wrote it;
//   * the refused name belongs to a qadam in this batch — this install is about to mark it usable.
//
// Note what is NOT softened either way: a signature that does not verify still throws for every
// official entry, introduced here or not. That is the substitution #482 exists to catch, and
// unlike a structural refusal it is evidence about bytes, not about a name someone chose.
const reportRefusals = ({ refusals, installed, refusedBeforeInstall, log }: {
    refusals: Refusal[]
    installed: QadamPackage[]
    refusedBeforeInstall: Set<string>
    log: Logger
}): void => {
    if (refusals.length === 0) {
        return
    }
    const installedNames = new Set(installed.map((piece) => piece.qadamName))
    const [introduced, alreadyPresent] = partition(refusals, (refusal) =>
        !refusedBeforeInstall.has(refusal.key) || installedNames.has(refusal.name))

    for (const refusal of alreadyPresent) {
        log.error({
            qadam: refusal.name,
            lockfileKey: refusal.key,
            reason: refusal.reason,
        }, '[qadamIntegrity] an official-scope package already in this workspace cannot be verified. This install did not introduce it, so the install continues — but while it is there it occupies an official name in node_modules and the engine loader will resolve it. Rename it.')
    }

    if (introduced.length > 0) {
        const detail = introduced.map(({ name, reason }) => `${name} (${reason})`).join('; ')
        throw new Error(`[qadamIntegrity] refusing to install: ${detail}`)
    }
}

// The guard verifies whatever official-scope entries it finds, so on its own it says nothing
// about the qadams this batch is about to mark usable. If bun ever stopped writing an entry for
// one of them, every one of them would be marked `ready` with nothing verified — a silent
// fail-open, and the only thing standing between here and that was a comment recording a
// measurement. Asserting it turns the assumption into a check that fails loudly.
//
// Coverage counts only entries sitting at their OWN name in the tree (`keyName === name`), which
// is narrower than the set this pass verifies. `classifyEntry` also admits the reverse alias — an
// out-of-scope key whose spec is official-scope, e.g. `"decoy": "npm:@aiqadam/qadam-x@1.0.0"` —
// because those bytes are official-scope bytes and the signature check should see them. But such
// an entry says nothing about the tree position the loader reads for `@aiqadam/qadam-x`, so
// counting it as coverage would let a declared dependency anywhere in the graph satisfy the
// assertion on a batch member's behalf. That would soften exactly the guarantee this assertion
// exists to make hard.
const assertBatchIsCovered = ({ resolved, installed }: { resolved: ResolvedPackage[], installed: QadamPackage[] }): void => {
    const covered = new Set(resolved
        .filter(({ keyName, name }) => keyName === name)
        .map(({ name, version }) => `${name}@${version}`))
    const missing = installed
        .filter((piece) => piece.qadamType === QadamType.OFFICIAL)
        .filter((piece) => !covered.has(`${piece.qadamName}@${piece.qadamVersion}`))
    if (missing.length > 0) {
        const names = missing.map((piece) => `${piece.qadamName}@${piece.qadamVersion}`).join(', ')
        throw new Error(`[qadamIntegrity] refusing to mark ${names} usable: ${LOCKFILE_NAME} carries no registry entry for them, so nothing about the bytes bun installed could be verified.`)
    }
}

// Scope is decided on the MAP KEY as well as on the spec, and an official-scope key that is not a
// plain registry install is refused rather than skipped. Both halves came out of review, and in
// both the old behaviour was to fail open on exactly the substitution this guard exists to catch:
//
//   * bun keys a package by its PATH in the tree, and the leaf of that path is the name the
//     package occupies in `node_modules` — the name the engine's loader resolves. An alias
//     (`"@aiqadam/qadam-x": "npm:something-else@1.0.0"`) writes an official-scope KEY with an
//     out-of-scope SPEC, so reading the spec alone drops it and unverified bytes sit at an
//     official-scope path. Reading the key alone is no better: name and version still have to
//     come from the spec, because the same package at two versions is keyed `x` and `parent/x`.
//     So both are read, and where the key is official they must agree.
//   * A tarball or URL dependency writes a THREE-element entry with no registry field (measured:
//     `["@aiqadam/qadam-x@/abs/path.tgz", {}, "sha512-…"]`). npmjs cannot be asked to sign a
//     local tarball, so no version of this check can pass it and refusing is the only honest
//     answer. In practice that is a CUSTOM ARCHIVE qadam registered under an official name —
//     which `buildInstallBunfig` already refuses to exempt from quarantine for the same
//     shadowing reason. The operator's fix is to rename it.
//
// A workspace member is a one-element entry and is skipped: those are the `qadams/<name>-<ver>`
// directories this installer writes itself, and they were never published.
const classifyEntry = ({ key, entry }: { key: string, entry: unknown }): ResolvedPackage | Refusal | undefined => {
    const keyName = lockfileKeyName(key)
    const keyIsOfficial = keyName.startsWith(OFFICIAL_QADAM_SCOPE_PREFIX)

    if (!Array.isArray(entry)) {
        // Not a shape bun is documented to write, so there is nothing to interpret. Under an
        // official-scope key that is a refusal rather than a skip, for the same reason every other
        // uninterpretable shape is: the guard cannot say anything about those bytes, and "cannot
        // say" must not read as "fine".
        return keyIsOfficial ? { key, name: keyName, reason: `its ${LOCKFILE_NAME} entry is not an array, so it is not a shape this can verify` } : undefined
    }
    if (entry.length === LOCKFILE_WORKSPACE_ENTRY_ARITY) {
        return undefined
    }

    if (entry.length !== LOCKFILE_REGISTRY_ENTRY_ARITY) {
        if (keyIsOfficial) {
            return { key, name: keyName, reason: `it resolves to a local tarball or URL rather than to the registry, so npmjs cannot have signed it. A custom qadam must not be registered under the ${OFFICIAL_QADAM_SCOPE_PREFIX} scope — rename it` }
        }
        return undefined
    }

    const parsed = parseLockfileEntry(entry)
    if (isNil(parsed)) {
        if (keyIsOfficial) {
            return { key, name: keyName, reason: `its ${LOCKFILE_NAME} entry is not a shape this can verify` }
        }
        return undefined
    }
    if (keyIsOfficial && parsed.name !== keyName) {
        return { key, name: keyName, reason: `it is an alias for ${parsed.name}, so what loads under the official name is not what npmjs would be signing` }
    }
    if (!keyIsOfficial && !parsed.name.startsWith(OFFICIAL_QADAM_SCOPE_PREFIX)) {
        return undefined
    }
    return { ...parsed, keyName }
}

// The name a package occupies in the tree, out of a key that may be a path. A name is either
// `foo` or `@scope/foo`, so it is the last segment plus the one before it when that is a scope.
const lockfileKeyName = (key: string): string => {
    const segments = key.split('/')
    const name = segments[segments.length - 1] ?? key
    const scope = segments[segments.length - 2]
    return !isNil(scope) && scope.startsWith('@') ? `${scope}/${name}` : name
}

const parseLockfileEntry = (entry: unknown[]): LockfileSpec | undefined => {
    const [spec, , , integrity] = entry
    if (typeof spec !== 'string' || typeof integrity !== 'string') {
        return undefined
    }
    // Scoped names carry a leading `@`, so the separator is the LAST `@`, not the first.
    const separatorIndex = spec.lastIndexOf('@')
    if (separatorIndex <= 0) {
        return undefined
    }
    const name = spec.slice(0, separatorIndex)
    const version = spec.slice(separatorIndex + 1)
    if (name.length === 0 || version.length === 0) {
        return undefined
    }
    return { name, version, integrity }
}

const verifySignature = async ({ pkg, deadline, log }: { pkg: ResolvedPackage, deadline: number, log: Logger }): Promise<void> => {
    const { name, version, integrity } = pkg
    const metadata = await readVersionMetadata({ name, version, deadline })

    const signatures = readSignatures(metadata)
    if (signatures.length === 0) {
        throw new Error(`[qadamIntegrity] refusing ${name}@${version}: the registry returned no publisher signature for it`)
    }

    // Filter to the keys this image pins BEFORE verifying, so an entry the registry added of its
    // own never even gets a verification attempt. Doing it the other way round — verify each
    // entry, then ask whether its key was pinned — is the same answer with a much easier mistake
    // available in it.
    const pinned = signatures.filter(({ keyid }) => !isNil(NPM_SIGNING_KEYS[keyid]))
    if (pinned.length === 0) {
        const offered = signatures.map(({ keyid }) => keyid).join(', ')
        throw new Error(`[qadamIntegrity] refusing ${name}@${version}: the registry signed it only with key id(s) this image does not pin (${offered}). If npmjs has rotated its signing key, the image needs updating; see NPM_SIGNING_KEYS.`)
    }

    // The payload binds all three together, so neither a substituted tarball (different
    // integrity) nor a replayed signature from another release (different version) verifies.
    const payload = Buffer.from(`${name}@${version}:${integrity}`)
    const verified = pinned.some((signature) => signatureVerifies({ signature, payload }))
    if (!verified) {
        throw new Error(`[qadamIntegrity] refusing ${name}@${version}: npmjs has not signed the bytes bun fetched — the integrity bun recorded (${integrity}) does not match any signature the registry holds for this version.`)
    }

    log.debug({ name, version }, '[qadamIntegrity] publisher signature verified')
}

// safeHttp rather than raw axios because `.agents/rules/safe-http.md` applies to every outbound
// request from the worker, including one to a hardcoded endpoint we trust.
//
// The retry here is for 429 only, because `retryingAxios` already covers 5xx and covers nothing
// else. Everything past it is reported as unreadable metadata, which is an AVAILABILITY failure
// rather than a security one. It still fails the install closed — a guard that waves a package
// through because it could not reach the registry is not a guard — but the wording distinguishes
// the two, so nobody goes looking for a compromise that is really an outage.
const readVersionMetadata = async ({ name, version, deadline }: { name: string, version: string, deadline: number }): Promise<unknown> => {
    const url = `${OFFICIAL_QADAM_REGISTRY_URL}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`
    let attempt = 1
    for (;;) {
        // The pass deadline caps the request rather than merely being checked around it, so one
        // slow read cannot carry the whole pass past the budget by up to a full timeout.
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            throw new Error(`[qadamIntegrity] refusing ${name}@${version}: the registry did not answer for the whole ${VERIFICATION_BUDGET_MS}ms this verification pass is allowed to hold the install lock`)
        }
        const { data: response, error } = await tryCatch(async () =>
            safeHttp.retryingAxios.get<unknown>(url, { timeout: Math.min(REGISTRY_TIMEOUT_MS, remaining) }),
        )
        if (isNil(error) && !isNil(response)) {
            return response.data
        }
        if (attempt >= REGISTRY_RATE_LIMIT_ATTEMPTS || !isRateLimited(error)) {
            throw new Error(`[qadamIntegrity] refusing ${name}@${version}: could not read its registry metadata to verify the publisher signature`)
        }
        // Clamped to the deadline, not just checked against it at the top of the loop: the sleep
        // is the one part of an attempt that runs outside the request timeout, so an unclamped
        // final backoff would carry the whole pass past the budget by up to its own length.
        await delay(Math.min(REGISTRY_RATE_LIMIT_BACKOFF_MS * 2 ** (attempt - 1), Math.max(0, deadline - Date.now())))
        attempt += 1
    }
}

// Read off the error rather than narrowed with a type guard from axios: `packages/server/.eslintrc.json`
// forbids importing axios in this package at all, and the response shape is the only thing needed.
const isRateLimited = (error: unknown): boolean =>
    readProperty({ source: readProperty({ source: error, key: 'response' }), key: 'status' }) === HTTP_TOO_MANY_REQUESTS

// Any signature under a PINNED key is enough; every signature under an unpinned key is ignored.
//
// The first spelling of this read `signatures[0]` and only that, reasoning that npm publishes
// one and that accepting "any entry verifies" would let a rewriting registry append its own next
// to the real one. The first half is simply not true — npmjs returns TWO entries for
// `@aiqadam/shared@0.135.1`, both valid, both under the same key id (see the fixture in
// qadam-integrity.test.ts, which is that package's real registry response). The second half is
// answered by the pinning, not by the index: an appended signature is one this image has no key
// for, so it is dropped before anything is verified. Taking the first entry only would have
// meant rejecting a package the moment npmjs reordered its own array or listed a rotated key
// ahead of the one we pin — a self-inflicted outage in exchange for nothing.
const readSignatures = (body: unknown): Signature[] => {
    const dist = readProperty({ source: body, key: 'dist' })
    const signatures = readProperty({ source: dist, key: 'signatures' })
    if (!Array.isArray(signatures)) {
        return []
    }
    return signatures.flatMap((entry) => {
        const keyid = readProperty({ source: entry, key: 'keyid' })
        const sig = readProperty({ source: entry, key: 'sig' })
        if (typeof keyid !== 'string' || typeof sig !== 'string') {
            return []
        }
        return [{ keyid, sig }]
    })
}

// `verify` throws on a malformed key or signature rather than returning false, and a malformed
// signature is a rejection rather than a crash.
const signatureVerifies = ({ signature, payload }: { signature: Signature, payload: Buffer }): boolean => {
    const publicKey = NPM_SIGNING_KEYS[signature.keyid]
    if (isNil(publicKey)) {
        return false
    }
    const { data: valid, error } = tryCatchSync(() => {
        const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
        return verify('sha256', payload, key, Buffer.from(signature.sig, 'base64'))
    })
    return isNil(error) && valid === true
}

// Everything this file reads out of the lockfile or the registry is external data of unknown
// shape, so it is walked key by key rather than cast into a type it is only assumed to have.
const readProperty = ({ source, key }: { source: unknown, key: string }): unknown =>
    isRecord(source) ? source[key] : undefined

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

// What a `bun.lock` entry's spec resolves to, before anything is known about where in the tree it
// sits. Split out from `ResolvedPackage` so `parseLockfileEntry` cannot accidentally mint one
// without the key it was read under.
type LockfileSpec = {
    name: string
    version: string
    integrity: string
}

// `keyName` is the name this package occupies in the tree — the leaf of its lockfile key — which
// is what the engine's loader resolves. It differs from `name` only for the reverse alias (an
// out-of-scope key whose spec is official-scope); `assertBatchIsCovered` is the one place that
// difference matters.
type ResolvedPackage = LockfileSpec & {
    keyName: string
}

// An official-scope entry no version of this check can pass — an alias, or a tarball/URL
// dependency npmjs was never asked to sign. Carried as data rather than thrown at the point it
// is spotted, so `reportRefusals` can tell "this install introduced it" from "it was already
// here", which are different failures with different remedies. `key` is the lockfile map key, and
// it rather than `name` is the identity: it is what a pre-install reading can be compared against.
type Refusal = {
    key: string
    name: string
    reason: string
}

type LockfileReading = {
    resolved: ResolvedPackage[]
    refusals: Refusal[]
}

type Signature = {
    keyid: string
    sig: string
}
