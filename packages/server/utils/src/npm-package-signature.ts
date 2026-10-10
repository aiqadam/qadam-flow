import { createPublicKey, verify } from 'node:crypto'
import { isNil, tryCatchSync } from '@aiqadam/shared'

// What npmjs signs and which keys this platform trusts to have signed it (#482, #780).
//
// npmjs signs the string `<name>@<version>:<dist.integrity>` with a registry key and publishes the
// signature in the version document (`dist.signatures`). The check is pure computation over those
// three values and a pinned key, so it needs no registry once the signature has been read: a
// signature kept next to the thing it covers (`QadamSignatureLedger`) proves the same thing the
// registry's answer did, and cannot be forged by whoever can write that file.
//
// npmjs's package-signing public keys are pinned rather than fetched.
//
// `npm audit signatures` reads these from `/-/npm/v1/keys` on the registry it is verifying, which
// is circular against the threat #482 actually names: an internal mirror or a transparently
// rewriting proxy serves its own key alongside its own matching signature and the check passes.
// Pinning is the whole reason this verification means anything.
//
// The cost of pinning is that an npmjs key rotation stops official qadam installs until the image
// carries the new key. That is accepted rather than softened: falling back to "unknown key id, so
// allow it" would hand an attacker the trivial bypass. A persisted signature (ledger) under a key
// that has left this list stops verifying the same way, and is then asked of the registry again.
// The escape hatch already exists and needs no new knob — `OFFICIAL_QADAMS_INSTALL_ENABLED=false`
// returns the deployment to the qadams compiled into the image, and is also what gates this check
// running at all.
//
// Refresh procedure: `curl https://registry.npmjs.org/-/npm/v1/keys` and add any new non-expired
// entry here, keeping the outgoing one until it is gone from that response. Entries npm marks
// with an `expires` date are deliberately NOT carried: a signature made by a key that has since
// expired is not evidence this guard should accept.
const NPM_SIGNING_KEYS: Record<string, string> = {
    'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U': 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
}

export const npmPackageSignature = {
    // The `dist.signatures` of a registry version document, as far as it has the expected shape.
    // The document is external data of unknown shape, so it is walked key by key rather than cast.
    readSignatures: ({ versionDocument }: { versionDocument: unknown }): NpmPackageSignature[] => {
        const signatures = readProperty({ source: readProperty({ source: versionDocument, key: 'dist' }), key: 'signatures' })
        if (!Array.isArray(signatures)) {
            return []
        }
        return signatures.flatMap((entry): NpmPackageSignature[] => {
            const keyid = readProperty({ source: entry, key: 'keyid' })
            const sig = readProperty({ source: entry, key: 'sig' })
            return typeof keyid === 'string' && typeof sig === 'string' ? [{ keyid, sig }] : []
        })
    },

    // The signatures under a key this platform pins. Everything else is ignored before anything is
    // verified, so an entry the registry added of its own never even gets a verification attempt.
    // Doing it the other way round — verify each entry, then ask whether its key was pinned — is the
    // same answer with a much easier mistake available in it.
    pinned: ({ signatures, trustedKeys = NPM_SIGNING_KEYS }: PinnedParams): NpmPackageSignature[] => {
        return signatures.filter(({ keyid }) => !isNil(findKey({ trustedKeys, keyid })))
    },

    // The signatures that verify for exactly this name, version and integrity, under a pinned key.
    // Any one is enough; npmjs publishes two entries under one key id for some packages. The
    // payload binds all three values, so neither a substituted tarball (different integrity) nor a
    // replayed signature from another release (different version) verifies.
    verifying: ({ name, version, integrity, signatures, trustedKeys = NPM_SIGNING_KEYS }: VerifyingParams): NpmPackageSignature[] => {
        const payload = Buffer.from(`${name}@${version}:${integrity}`)
        return npmPackageSignature.pinned({ signatures, trustedKeys }).filter((signature) => signatureVerifies({ signature, payload, trustedKeys }))
    },
}

// `verify` throws on a malformed key or signature rather than returning false, and a malformed
// signature is a rejection rather than a crash.
function signatureVerifies({ signature, payload, trustedKeys }: SignatureVerifiesParams): boolean {
    const publicKey = findKey({ trustedKeys, keyid: signature.keyid })
    if (isNil(publicKey)) {
        return false
    }
    const { data: valid, error } = tryCatchSync(() => {
        const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
        return verify('sha256', payload, key, Buffer.from(signature.sig, 'base64'))
    })
    return isNil(error) && valid === true
}

// Own properties only: a key id of `constructor` or `__proto__` must not find an inherited value.
function findKey({ trustedKeys, keyid }: { trustedKeys: NpmTrustedKeys, keyid: string }): string | undefined {
    return Object.hasOwn(trustedKeys, keyid) ? trustedKeys[keyid] : undefined
}

function readProperty({ source, key }: { source: unknown, key: string }): unknown {
    return isRecord(source) ? source[key] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type NpmPackageSignature = {
    keyid: string
    sig: string
}

// A key id to a base64 SPKI DER public key. Production callers leave it out and get the pinned
// npmjs keys; a test supplies its own.
export type NpmTrustedKeys = Record<string, string>

type PinnedParams = {
    signatures: NpmPackageSignature[]
    trustedKeys?: NpmTrustedKeys
}

type VerifyingParams = {
    name: string
    version: string
    integrity: string
    signatures: NpmPackageSignature[]
    trustedKeys?: NpmTrustedKeys
}

type SignatureVerifiesParams = {
    signature: NpmPackageSignature
    payload: Buffer
    trustedKeys: NpmTrustedKeys
}
