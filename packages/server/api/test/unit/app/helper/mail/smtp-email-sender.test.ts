import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isNil } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import pino from 'pino'
import { describe, expect, it } from 'vitest'
import { defaultTheme } from '../../../../../src/app/flags/theme'
import { toAbsoluteAssetUrl } from '../../../../../src/app/helper/mail/email-sender/smtp-email-sender'

// A real (silenced) pino logger structurally satisfies FastifyBaseLogger — see
// `pinoLogging.initLogger()` in `helper/logger/index.ts` — so no mock object or cast is needed.
const testLogger: FastifyBaseLogger = pino({ level: 'silent' })

// The pictograph and dingbat blocks the copy actually drew from, plus the variation selector that
// makes a text-default glyph try to present as emoji. Deliberately not every emoji range in
// Unicode — it would misfire on ordinary prose and on the Cyrillic in a translation — and not
// exhaustive of every way a glyph can render as emoji either: it misses regional-indicator flags,
// U+2B50, keycaps without VS16 and the U+2190-21FF arrows, and it would also flag a dingbat a
// template might legitimately want (✓ U+2713, ★ U+2605, ⚡ U+26A1). It only guards the templates
// against reintroducing the specific glyphs that shipped broken here before.
const KNOWN_OFFENDING_GLYPHS = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{2600}-\u{26FF}\u{FE0F}]/gu

describe('smtpEmailSender', () => {
    // Not style: Gmail strips SVG from an email body outright and Outlook's Word engine cannot
    // render it, so a vector default would be invisible to most recipients even once the URL
    // is absolute. The same reasoning is why og:image points at a PNG.
    it('ships a raster default logo, because email clients do not render SVG', () => {
        expect(defaultTheme.logos.fullLogoUrl).toMatch(/\.(png|jpe?g|gif)$/)
    })

    // Also not style. U+2709 and U+26A0 are Unicode 1.1 dingbats whose *default* presentation
    // is text, so they render as a grey outline anywhere the VS16 selector is ignored — while
    // the U+1F511 / U+2705 sitting next to them in other templates always came out in colour.
    // One template therefore looked broken beside another. Rather than curate a per-client list
    // of "safe" codepoints, no template carries any.
    it('keeps the known-offending glyph ranges out of every subject and template', async () => {
        const emailsDir = path.resolve(__dirname, '../../../../../src/assets/emails')
        const templates = (await readdir(emailsDir)).filter((f) => f.endsWith('.html'))
        const sources: [string, string][] = await Promise.all(
            templates.map(async (f): Promise<[string, string]> => [f, await readFile(path.join(emailsDir, f), 'utf-8')]),
        )
        // The subjects live in code, not in a template, and were the more visible half.
        sources.push(['getEmailSubject', await readFile(
            path.resolve(__dirname, '../../../../../src/app/helper/mail/email-sender/smtp-email-sender.ts'),
            'utf-8',
        )])

        const offenders = sources
            .map(([name, body]): [string, string[]] => [name, [...new Set(body.match(KNOWN_OFFENDING_GLYPHS) ?? [])]])
            .filter(([, found]) => found.length > 0)
            .map(([name, found]) => `${name}: ${found.join(' ')}`)

        expect(offenders).toEqual([])
    })

    describe('toAbsoluteAssetUrl', () => {
        it.each([
            ['an operator CDN URL', 'https://cdn.example/brand/logo.png'],
            ['a data URI', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
            ['a plain http URL', 'http://assets.internal/logo.png'],
        ])('leaves %s untouched — prefixing it would corrupt it', async (_label, absolute) => {
            expect(await toAbsoluteAssetUrl({ assetUrl: absolute, log: testLogger })).toBe(absolute)
        })

        it('falls back to the original value rather than throwing when getPublicUrl rejects', async () => {
            // `domainHelper.getPublicUrl` is `getOrThrow(FRONTEND_URL)`, which is unset here only to
            // force the rejection this unit guards against. A real app process cannot sit in that
            // state: `main.ts` awaits `appPostBoot` -> `getPublicApiUrl` -> the same `getOrThrow`
            // right after `app.listen`, and a throw there exits the process within milliseconds of
            // binding the port. This case exists for defence in depth, not as a state a deployment
            // can be running in.
            const frontendUrl = process.env.AP_FRONTEND_URL
            delete process.env.AP_FRONTEND_URL
            try {
                expect(await toAbsoluteAssetUrl({ assetUrl: '/logo.svg', log: testLogger })).toBe('/logo.svg')
            }
            finally {
                if (!isNil(frontendUrl)) {
                    process.env.AP_FRONTEND_URL = frontendUrl
                }
            }
        })
    })
})
