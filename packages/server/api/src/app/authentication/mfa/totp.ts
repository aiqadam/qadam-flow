import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// RFC 6238 TOTP over RFC 4226 HOTP, SHA-1, 6 digits, 30-second steps. Deliberately implemented
// here instead of adding a dependency: the whole surface is ~80 lines, and a hand-rolled
// implementation avoids pulling a package into the server image for three arithmetic operations.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30
const DIGITS = 6
const SECRET_BYTES = 20

export const mfaTotp = {
    generateSecret,
    encodeBase32,
    decodeBase32,
    generateCode,
    verify,
    buildOtpauthUrl,
}

function generateSecret(): string {
    return encodeBase32(randomBytes(SECRET_BYTES))
}

function encodeBase32(buffer: Buffer): string {
    let bits = 0
    let value = 0
    let output = ''
    for (const byte of buffer) {
        value = (value << 8) | byte
        bits += 8
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
            bits -= 5
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31]
    }
    return output
}

function decodeBase32(input: string): Buffer {
    const cleaned = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '')
    let bits = 0
    let value = 0
    const bytes: number[] = []
    for (const character of cleaned) {
        const index = BASE32_ALPHABET.indexOf(character)
        if (index === -1) {
            throw new Error('Invalid base32 character')
        }
        value = (value << 5) | index
        bits += 5
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff)
            bits -= 8
        }
    }
    return Buffer.from(bytes)
}

function generateCode({ secret, step }: { secret: string, step: number }): string {
    const key = decodeBase32(secret)
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(BigInt(step))
    const digest = createHmac('sha1', key).update(counter).digest()
    const offset = digest[digest.length - 1] & 0x0f
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff)
    return (binary % (10 ** DIGITS)).toString().padStart(DIGITS, '0')
}

function currentStep(nowMs: number = Date.now()): number {
    return Math.floor(nowMs / 1000 / STEP_SECONDS)
}

// Returns the matched time-step, or `null`. Comparison is constant-time; the ±1 step window is
// the usual allowance for clock drift between server and authenticator app. The caller is
// responsible for the replay guard (rejecting a step that was already accepted).
function verify({ secret, code, window = 1, nowMs = Date.now() }: VerifyParams): number | null {
    const normalized = code.replace(/\s+/g, '')
    const presented = Buffer.from(normalized, 'utf8')
    if (presented.length !== DIGITS) {
        return null
    }
    const step = currentStep(nowMs)
    for (let offset = -window; offset <= window; offset++) {
        const candidateStep = step + offset
        if (candidateStep < 0) {
            continue
        }
        const expected = Buffer.from(generateCode({ secret, step: candidateStep }), 'utf8')
        if (timingSafeEqual(presented, expected)) {
            return candidateStep
        }
    }
    return null
}

function buildOtpauthUrl({ secret, accountName, issuer }: BuildOtpauthUrlParams): string {
    const label = encodeURIComponent(`${issuer}:${accountName}`)
    const params = new URLSearchParams({
        secret,
        issuer,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS),
    })
    return `otpauth://totp/${label}?${params.toString()}`
}

type VerifyParams = {
    secret: string
    code: string
    window?: number
    nowMs?: number
}

type BuildOtpauthUrlParams = {
    secret: string
    accountName: string
    issuer: string
}
