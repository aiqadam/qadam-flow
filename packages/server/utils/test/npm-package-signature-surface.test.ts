import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as serverUtils from '../src/index'
import { qadamSignatureLedger } from '../src/qadam-version-store/qadam-signature-ledger'

// #482 rejected verifying npm signatures with keys read from the registry being verified: a rewriting
// mirror serves its own key with its own matching signature. The only keys production code may trust
// are the ones pinned in `npm-package-signature.ts`, so the entry points that accept other keys exist
// for this package's tests and must not become reachable from anywhere else.
const SERVER_PACKAGES = resolve(__dirname, '../..')
const DEFINING_FILES = [
    join(SERVER_PACKAGES, 'utils/src/npm-package-signature.ts'),
    join(SERVER_PACKAGES, 'utils/src/qadam-version-store/qadam-signature-ledger.ts'),
]
const KEY_INJECTION = /createNpmPackageSignatureVerifier|createQadamSignatureLedger|NpmTrustedKeys|trustedKeys/

describe('the keys npm signatures are verified against', () => {
    it('are not exported from the package, by name or by shape', () => {
        const exported = Object.keys(serverUtils)

        expect(exported).toContain('npmPackageSignature')
        expect(exported).toContain('qadamSignatureLedger')
        expect(exported).not.toContain('createNpmPackageSignatureVerifier')
        expect(exported).not.toContain('createQadamSignatureLedger')
        expect(Object.keys(serverUtils.npmPackageSignature).sort()).toEqual(['pinned', 'readSignatures', 'verifying'])
    })

    it('cannot be passed to the ledger or the verifier production code gets', async () => {
        const log = { warn: vi.fn() }
        // @ts-expect-error `trustedKeys` is not a parameter of the public `open`
        const ledger = qadamSignatureLedger.open({ dir: '/nonexistent', log, trustedKeys: { 'SHA256:any': 'AAAA' } })

        const recorded = await ledger.record({ proofs: [{ name: '@aiqadam/qadam-x', version: '1.0.0', integrity: 'sha512-AAAA', signatures: [{ keyid: 'SHA256:any', sig: 'AAAA' }] }] })

        expect(recorded).toEqual({ ok: true, recorded: 0, rejected: 1 })
    })

    it('are not named by any source file of the server packages outside the two that define them', () => {
        const offenders = sourceFiles({ dir: SERVER_PACKAGES })
            .filter((file) => !DEFINING_FILES.includes(file))
            .filter((file) => KEY_INJECTION.test(readFileSync(file, 'utf8')))

        expect(offenders).toEqual([])
    })
})

function sourceFiles({ dir }: { dir: string }): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
            return ['node_modules', 'dist', 'test', 'tests', '.turbo'].includes(entry.name) ? [] : sourceFiles({ dir: path })
        }
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [path] : []
    })
}
