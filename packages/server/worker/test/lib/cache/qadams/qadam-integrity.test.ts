import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Logger } from 'pino'

const mockGet = vi.fn()
// Stubbed rather than driven with fake timers: `vi.useFakeTimers()` does not intercept
// `node:timers/promises` here, so the backoff slept for real and the test timed out. Recording
// the requested delays is the better assertion anyway — it pins the schedule (2s, 4s, 8s), which
// advancing a clock past all of them would not.
const mockDelay = vi.fn<(ms: number) => Promise<void>>()

vi.mock('node:timers/promises', () => ({
    setTimeout: (ms: number) => mockDelay(ms),
}))

vi.mock('@aiqadam/server-utils', () => ({
    safeHttp: {
        retryingAxios: {
            get: mockGet,
        },
    },
}))

// Re-imported per test rather than once at the top. The module keeps its already-verified set in
// a module-level Set — deliberately, since the lockfile is cumulative and every install would
// otherwise re-check the whole official set — so a single import would let the first test's
// success answer every later test from memory. Two of the cases below assert on the registry
// call actually happening; without the reset they would pass with the verification deleted.
let qadamIntegrity: typeof import('../../../../src/lib/cache/qadams/qadam-integrity').qadamIntegrity

// `@aiqadam/shared@0.135.1`'s real registry response, copied verbatim from
// `https://registry.npmjs.org/@aiqadam/shared/0.135.1`. Using the real thing rather than a
// keypair generated in the test is the point of this fixture: a synthetic signature proves the
// code can verify a signature it made itself, while this proves the key pinned in
// NPM_SIGNING_KEYS verifies what npmjs actually produces. If npmjs rotates that key, these tests
// go red — which is exactly the notice the pinning needs, since a rotation otherwise surfaces as
// every official qadam install failing in production.
//
// Note the TWO signatures. That is npmjs's real output, not a fixture embellishment, and it is
// what corrected this file's first design: it read `signatures[0]` and nothing else.
const SHARED = {
    name: '@aiqadam/shared',
    version: '0.135.1',
    integrity: 'sha512-j5nuNiIPD0IE/dNPc9UPuHIizrtYaGRY6rqiQmlfhqznjqQ4EcYUyfWIf+0zANVRsjCkOuFaYiWsEEi0smFr5g==',
    signatures: [
        {
            sig: 'MEUCIANumo7KyQ7w8ye4sAIWc3H412PbsYzVReXWbPM/zrMTAiEApFvtQILprUNqObuohXZpVUyOia0fqyaampEskAK3y7s=',
            keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
        },
        {
            sig: 'MEQCIAOe6IcvUIo3DKgoOJCUFlOObfMMqMJhyXlR8avwC9drAiB76Mbj7dqzNkmZI3HGTstb9SnNZHmMPdrkZ8T8uJLAhA==',
            keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
        },
    ],
}

const UNPINNED_KEY_ID = 'SHA256:0000000000000000000000000000000000000000000='

const log = {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
} as unknown as Logger

// bun writes JSONC with trailing commas, which is why the parser is jsonc-parser and why the
// fixture is written as text rather than JSON.stringify'd — a lockfile that JSON.parse accepts
// would not exercise the reason that dependency is there.
async function writeLockfile(entries: string): Promise<string> {
    const workspace = await mkdtemp(join(tmpdir(), 'qadam-integrity-'))
    await writeFile(join(workspace, 'bun.lock'), `{
  "lockfileVersion": 1,
  "workspaces": {
    "": { "name": "qadam-flow" },
  },
  "packages": {
${entries}
  },
}
`)
    return workspace
}

function registryEntry({ name, version, integrity }: { name: string, version: string, integrity: string }): string {
    return `    "${name}": ["${name}@${version}", "", {}, "${integrity}"],`
}

function packumentFor(signatures: { sig: string, keyid: string }[]): { data: unknown } {
    return { data: { dist: { signatures } } }
}

describe('qadamIntegrity.verifyOfficialQadams', () => {
    beforeEach(async () => {
        vi.clearAllMocks()
        mockGet.mockReset()
        mockDelay.mockReset()
        mockDelay.mockResolvedValue(undefined)
        vi.resetModules()
        ;({ qadamIntegrity } = await import('../../../../src/lib/cache/qadams/qadam-integrity'))
    })

    it('accepts a package whose installed bytes npmjs has signed', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
        expect(mockGet).toHaveBeenCalledWith('https://registry.npmjs.org/%40aiqadam%2Fshared/0.135.1', { timeout: 30_000 })
    })

    // The whole point of the guard: a mirror that served different bytes produces a different
    // integrity in bun.lock, and cannot produce a signature over it.
    it('refuses a package whose recorded integrity is not what npmjs signed', async () => {
        const tampered = SHARED.integrity.replace('j5nu', 'J5nu')
        const workspace = await writeLockfile(registryEntry({ ...SHARED, integrity: tampered }))
        mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/npmjs has not signed the bytes bun fetched/)
    })

    // A replayed signature from a different release of the same package. The payload binds the
    // version, so it does not verify — asserted rather than assumed, because "the signature is
    // over the integrity" would be just as true of a payload that omitted the version.
    it('refuses a signature made for a different version of the same package', async () => {
        const workspace = await writeLockfile(registryEntry({ ...SHARED, version: '0.135.0' }))
        mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/npmjs has not signed the bytes bun fetched/)
    })

    it('refuses a package the registry offers no signature for', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockResolvedValue(packumentFor([]))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/returned no publisher signature/)
    })

    // The threat the pinning exists for: a rewriting proxy serving its own key alongside its own
    // matching signature. Fetching the key from the registry being verified would pass this.
    it('refuses a signature made with a key id this image does not pin', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockResolvedValue(packumentFor([{ sig: SHARED.signatures[0].sig, keyid: UNPINNED_KEY_ID }]))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/does not pin/)
    })

    // The regression the `signatures[0]` version would have shipped: npmjs listing a key we do
    // not pin first would have failed a package it also signed with one we do.
    it('accepts when a pinned key signs any entry, not only the first', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockResolvedValue(packumentFor([
            { sig: SHARED.signatures[0].sig, keyid: UNPINNED_KEY_ID },
            SHARED.signatures[1],
        ]))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
    })

    // ...and the other half of that: an appended entry cannot BUY acceptance, because the key it
    // is signed with is not one this image holds. Without this the case above would be an
    // argument for accepting anything in the array.
    it('is not satisfied by an extra signature under an unpinned key', async () => {
        const workspace = await writeLockfile(registryEntry({ ...SHARED, integrity: SHARED.integrity.replace('j5nu', 'J5nu') }))
        mockGet.mockResolvedValue(packumentFor([
            ...SHARED.signatures,
            { sig: SHARED.signatures[0].sig, keyid: UNPINNED_KEY_ID },
        ]))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/npmjs has not signed the bytes bun fetched/)
    })

    it('refuses when the registry metadata cannot be read at all', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockRejectedValue(new Error('ECONNREFUSED'))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/could not read its registry metadata/)
    })

    // `retryingAxios` retries 5xx and nothing else, so a 429 arrives here unhandled. It is also
    // the failure most likely to happen: every worker replica coming out of a cold cache reads
    // the same registry at once. Without this the anticipated case fails the install outright.
    it('backs off and retries a rate-limited registry read', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet
            .mockRejectedValueOnce({ response: { status: 429 } })
            .mockResolvedValueOnce(packumentFor(SHARED.signatures))

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
        expect(mockGet).toHaveBeenCalledTimes(2)
        expect(mockDelay.mock.calls.flat()).toEqual([2_000])
    })

    // Bounded, and it still fails the install closed at the end — a guard that waves a package
    // through because the registry would not answer is not a guard.
    it('gives up on a registry that keeps rate-limiting, and fails closed', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockRejectedValue({ response: { status: 429 } })

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/could not read its registry metadata/)
        expect(mockGet).toHaveBeenCalledTimes(4)
        expect(mockDelay.mock.calls.flat()).toEqual([2_000, 4_000, 8_000])
    })

    // A non-429 failure is not retried: it is not the contention this backoff exists for, and
    // sitting on it holds the installer's file lock that every other replica is waiting on.
    it('does not back off on a failure that is not a rate limit', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockRejectedValue({ response: { status: 404 } })

        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
            .rejects.toThrow(/could not read its registry metadata/)
        expect(mockGet).toHaveBeenCalledOnce()
        expect(mockDelay).not.toHaveBeenCalled()
    })

    describe('what it reads out of the lockfile', () => {
        it('checks only the official scope, leaving third-party dependencies alone', async () => {
            const workspace = await writeLockfile([
                registryEntry({ name: 'lodash', version: '4.17.21', integrity: 'sha512-unsigned' }),
                registryEntry({ name: '@types/node', version: '24.11.0', integrity: 'sha512-unsigned' }),
            ].join('\n'))

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
            expect(mockGet).not.toHaveBeenCalled()
        })

        // A workspace member is a one-element entry with no integrity. Treating it as a registry
        // entry would ask npmjs to sign a package that was never published.
        it('skips workspace members, which carry no integrity', async () => {
            const workspace = await writeLockfile('    "@aiqadam/shared": ["@aiqadam/shared@workspace:packages/shared"],')

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
            expect(mockGet).not.toHaveBeenCalled()
        })

        // bun keys a package by its PATH in the tree, so the same package at two versions is
        // keyed `x` and `y/x`. Name and version therefore come from the spec, never the key.
        it('reads the name and version from the spec, not from the tree path key', async () => {
            const workspace = await writeLockfile(
                `    "@aiqadam/qadam-slack/@aiqadam/shared": ["${SHARED.name}@${SHARED.version}", "", {}, "${SHARED.integrity}"],`,
            )
            mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
            expect(mockGet).toHaveBeenCalledWith('https://registry.npmjs.org/%40aiqadam%2Fshared/0.135.1', { timeout: 30_000 })
        })

        // The key is the package's PATH in the tree, so its leaf is the name the engine's loader
        // resolves. An alias puts an official-scope name on a package published under another
        // one; reading the spec alone drops it from the official set and leaves unverified bytes
        // sitting at an official-scope path, which is the substitution #482 names.
        it('refuses an official-scope name aliased to another package', async () => {
            const workspace = await writeLockfile(
                '    "@aiqadam/qadam-slack": ["not-ours@1.0.0", "", {}, "sha512-whatever"],',
            )

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
                .rejects.toThrow(/refusing @aiqadam\/qadam-slack: it is an alias for not-ours/)
            expect(mockGet).not.toHaveBeenCalled()
        })

        // Same shape, one level down the tree: the scope test has to run on the key's leaf, not
        // on the whole key, or a nested alias reads as out-of-scope and is skipped.
        it('applies the same reading to a nested tree path', async () => {
            const workspace = await writeLockfile(
                '    "some-dep/@aiqadam/shared": ["not-ours@1.0.0", "", {}, "sha512-whatever"],',
            )

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
                .rejects.toThrow(/refusing @aiqadam\/shared: it is an alias for not-ours/)
        })

        // A tarball or URL dependency is a three-element entry with no registry field. npmjs
        // cannot be asked to sign a local tarball, so refusing is the only honest answer — and
        // skipping it would be the fail-open this guard exists to close.
        it('refuses an official-scope name resolved from a local tarball', async () => {
            const workspace = await writeLockfile(
                '    "@aiqadam/qadam-slack": ["@aiqadam/qadam-slack@/tmp/qadam.tgz", {}, "sha512-whatever"],',
            )

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
                .rejects.toThrow(/resolves to a local tarball or URL/)
            expect(mockGet).not.toHaveBeenCalled()
        })

        // ...but only for the official scope: a third-party tarball dependency is a normal thing
        // for a community qadam to carry, and refusing those would fail installs that work today.
        it('leaves an out-of-scope tarball dependency alone', async () => {
            const workspace = await writeLockfile(
                '    "vendored-thing": ["vendored-thing@/tmp/vendored.tgz", {}, "sha512-whatever"],',
            )

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })).resolves.toBeUndefined()
            expect(mockGet).not.toHaveBeenCalled()
        })

        it('fails loudly when there is no lockfile to read', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'qadam-integrity-'))

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
                .rejects.toThrow(/bun\.lock is unreadable/)
        })

        it('fails loudly when the lockfile carries no packages map', async () => {
            const workspace = await mkdtemp(join(tmpdir(), 'qadam-integrity-'))
            await writeFile(join(workspace, 'bun.lock'), '{ "lockfileVersion": 1 }')

            await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace }))
                .rejects.toThrow(/no packages map/)
        })
    })

    // A filtered `bun install` still resolves every workspace member, so the lockfile this reads
    // is the whole workspace's and not the batch's. Without the cache every install would
    // re-verify the entire official set against the registry, which is its own way to earn a 429.
    it('verifies a given package only once per process', async () => {
        const workspace = await writeLockfile(registryEntry(SHARED))
        mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

        await qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })
        await qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: workspace })

        expect(mockGet).toHaveBeenCalledTimes(1)
    })

    // ...but the cache is keyed on the whole triple, not on `name@version`. The same version
    // turning up with a DIFFERENT integrity is precisely the event this guard exists to catch,
    // and a cache keyed on the version alone would answer it from memory and wave it through.
    it('re-verifies when the same version turns up with a different integrity', async () => {
        const honest = await writeLockfile(registryEntry(SHARED))
        const substituted = await writeLockfile(registryEntry({ ...SHARED, integrity: SHARED.integrity.replace('j5nu', 'J5nu') }))
        mockGet.mockResolvedValue(packumentFor(SHARED.signatures))

        await qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: honest })
        await expect(qadamIntegrity(log).verifyOfficialQadams({ rootWorkspace: substituted })).rejects.toThrow()
        expect(mockGet).toHaveBeenCalledTimes(2)
    })
})
