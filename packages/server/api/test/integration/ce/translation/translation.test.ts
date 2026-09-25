import { apId, DefaultProjectRole, TranslationImportFormat, TranslationImportMode } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import { createMemberContext, createServiceContext, createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

describe('Translation CE API', () => {
    describeWithAuth('POST /v1/translations (batch upsert)', () => app!, (setup) => {
        it('creates a key with multiple locales', async () => {
            const ctx = await setup()

            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [
                    { key: 'welcome.title', values: { en: 'Welcome', ru: 'Добро пожаловать' } },
                ],
            })

            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json()
            expect(body).toHaveLength(1)
            expect(body[0].key).toBe('welcome.title')
            expect(body[0].values).toEqual({ en: 'Welcome', ru: 'Добро пожаловать' })
        })

        it('merges into existing locales rather than replacing them', async () => {
            const ctx = await setup()

            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'merge.key', values: { en: 'Hello' } }],
            })
            const second = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'merge.key', values: { ru: 'Привет' } }],
            })

            expect(second.statusCode).toBe(StatusCodes.OK)
            expect(second.json()[0].values).toEqual({ en: 'Hello', ru: 'Привет' })
        })

        it('rejects an invalid key', async () => {
            const ctx = await setup()

            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'not a valid key!', values: { en: 'x' } }],
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('rejects a key with more than 50 locales (M4)', async () => {
            const ctx = await setup()
            const values: Record<string, string> = {}
            // 51 distinct, individually-valid BCP-47 tags — one past MAX_TRANSLATION_LOCALES_PER_KEY.
            for (let i = 0; i < 51; i++) {
                values[`en-x-${i.toString().padStart(4, '0')}`] = 'v'
            }

            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'too.many.locales', values }],
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('rejects a description longer than 500 characters (M4)', async () => {
            const ctx = await setup()

            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'long.description', values: { en: 'x' }, description: 'a'.repeat(501) }],
            })

            expect(response.statusCode).toBe(StatusCodes.BAD_REQUEST)
        })

        it('two concurrent batch upserts to the same project both succeed (advisory lock does not deadlock or corrupt writes)', async () => {
            const ctx = await setup()

            const [first, second] = await Promise.all([
                ctx.post('/v1/translations', {
                    projectId: ctx.project.id,
                    translations: [{ key: 'concurrent.a', values: { en: 'A' } }],
                }),
                ctx.post('/v1/translations', {
                    projectId: ctx.project.id,
                    translations: [{ key: 'concurrent.b', values: { en: 'B' } }],
                }),
            ])

            expect(first.statusCode).toBe(StatusCodes.OK)
            expect(second.statusCode).toBe(StatusCodes.OK)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'concurrent' })
            expect(list.json().data).toHaveLength(2)
        })
    })

    describeWithAuth('GET /v1/translations (list)', () => app!, (setup) => {
        it('filters by a key substring', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [
                    { key: 'errors.notFound', values: { en: 'Not found' } },
                    { key: 'labels.submit', values: { en: 'Submit' } },
                ],
            })

            const response = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'errors' })
            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json()
            expect(body.data).toHaveLength(1)
            expect(body.data[0].key).toBe('errors.notFound')
        })
    })

    describeWithAuth('DELETE /v1/translations/:id', () => app!, (setup) => {
        it('deletes a translation key', async () => {
            const ctx = await setup()
            const created = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'to.delete', values: { en: 'x' } }],
            })
            const id = created.json()[0].id

            const response = await ctx.delete(`/v1/translations/${id}`, { projectId: ctx.project.id })
            expect(response.statusCode).toBe(StatusCodes.NO_CONTENT)

            const listResponse = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'to.delete' })
            expect(listResponse.json().data).toHaveLength(0)
        })
    })

    describeWithAuth('POST /v1/translations/import', () => app!, (setup) => {
        it('merge mode overwrites only the imported locale and keeps other keys/locales untouched', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [
                    { key: 'a.key', values: { en: 'A (en)', ru: 'A (ru)' } },
                    { key: 'b.key', values: { ru: 'B (ru)' } },
                ],
            })

            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.MERGE,
                data: { 'a.key': 'A (en) updated' },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json()).toEqual({ importedKeys: 1, removedFromLocale: 0 })

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id })
            const byKey = Object.fromEntries(list.json().data.map((row: { key: string, values: Record<string, string> }) => [row.key, row.values]))
            expect(byKey['a.key']).toEqual({ en: 'A (en) updated', ru: 'A (ru)' })
            expect(byKey['b.key']).toEqual({ ru: 'B (ru)' })
        })

        it('replace mode strips the imported locale from keys absent from the payload, never other locales', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [
                    { key: 'replace.kept', values: { en: 'kept (en)', ru: 'kept (ru)' } },
                    { key: 'replace.dropped', values: { en: 'dropped (en)', ru: 'dropped (ru)' } },
                ],
            })

            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.REPLACE,
                data: { 'replace.kept': 'kept (en) v2' },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().removedFromLocale).toBe(1)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id })
            const byKey = Object.fromEntries(list.json().data.map((row: { key: string, values: Record<string, string> }) => [row.key, row.values]))
            expect(byKey['replace.kept']).toEqual({ en: 'kept (en) v2', ru: 'kept (ru)' })
            // `en` removed, `ru` untouched — never the whole row.
            expect(byKey['replace.dropped']).toEqual({ ru: 'dropped (ru)' })
        })

        it('rejects a 50k-key import fast instead of hanging on a quadratic flatten (B1)', async () => {
            const ctx = await setup()
            // Short keys/values keep the whole JSON payload comfortably under
            // `MAX_TRANSLATION_IMPORT_BYTES` (1 MB) — the point is to exercise the service's own
            // per-project key-count cap during flattening, not the controller's separate byte cap.
            const data: Record<string, string> = {}
            for (let i = 0; i < 50_000; i++) {
                Object.defineProperty(data, `k${i}`, { value: '1', writable: true, enumerable: true, configurable: true })
            }

            const startedAt = Date.now()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.MERGE,
                data,
            })
            const elapsedMs = Date.now() - startedAt

            // RESOURCE_LIMIT_EXCEEDED maps to 403 (error-handler.ts), not 400.
            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
            // Generously bounded: the previous quadratic flatten took ~6s at 5k keys and did not
            // finish within 290s at 20k; the fixed, cap-aborting path should reject in well under
            // a second even at 50k, but 10s leaves ample headroom for a loaded CI runner.
            expect(elapsedMs).toBeLessThan(10_000)
        })

        it('accepts a nested payload', async () => {
            const ctx = await setup()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.NESTED,
                mode: TranslationImportMode.MERGE,
                data: { nested: { greeting: 'Hi' } },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().importedKeys).toBe(1)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'nested.greeting' })
            expect(list.json().data[0].values).toEqual({ en: 'Hi' })
        })

        // `import`'s DTO has no per-value length schema (only the whole-payload byte cap) — this
        // reaches ONLY the service-level `upsertMergingValues` re-validation (M4), not a REST DTO
        // check, unlike the same cap on POST /v1/translations (already enforced by
        // UpsertTranslationRequestItem's zod schema before the request reaches the service).
        it('rejects an imported value longer than TRANSLATION_VALUE_MAX_LENGTH (M4)', async () => {
            const ctx = await setup()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.MERGE,
                data: { 'too.long': 'x'.repeat(10_001) },
            })
            // ErrorCode.VALIDATION maps to 409 (error-handler.ts), not the 400 a zod/DTO schema
            // failure produces — this request never reaches a schema that caps value length.
            expect(response.statusCode).toBe(StatusCodes.CONFLICT)
        })
    })

    describeWithAuth('GET /v1/translations/export', () => app!, (setup) => {
        it('exports flat by default and nested on request', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'export.key', values: { en: 'Exported' } }],
            })

            const flat = await ctx.get('/v1/translations/export', { projectId: ctx.project.id, locale: 'en' })
            expect(flat.statusCode).toBe(StatusCodes.OK)
            expect(flat.json()['export.key']).toBe('Exported')

            const nested = await ctx.get('/v1/translations/export', { projectId: ctx.project.id, locale: 'en', format: TranslationImportFormat.NESTED })
            expect(nested.json().export.key).toBe('Exported')
        })
    })

    describe('permissions', () => {
        it('a VIEWER can read but cannot write', async () => {
            const ownerCtx = await createTestContext(app!)
            const viewerCtx = await createMemberContext(app!, ownerCtx, { projectRole: DefaultProjectRole.VIEWER })

            const writeResponse = await viewerCtx.post('/v1/translations', {
                projectId: viewerCtx.project.id,
                translations: [{ key: 'viewer.attempt', values: { en: 'x' } }],
            })
            expect(writeResponse.statusCode).toBe(StatusCodes.FORBIDDEN)

            const readResponse = await viewerCtx.get('/v1/translations', { projectId: viewerCtx.project.id })
            expect(readResponse.statusCode).toBe(StatusCodes.OK)
        })

        it('a SERVICE principal can import translations', async () => {
            const userCtx = await createTestContext(app!)
            const serviceCtx = await createServiceContext(app!, userCtx)

            const response = await serviceCtx.post('/v1/translations/import', {
                projectId: serviceCtx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.MERGE,
                data: { 'service.imported': 'via CI' },
            })
            expect(response.statusCode).toBe(StatusCodes.OK)
        })
    })

    describe('whole-table byte cap (M4)', () => {
        it('rejects a write once the project\'s translation table already exceeds MAX_TRANSLATION_TABLE_BYTES_PER_PROJECT', async () => {
            const ctx = await createTestContext(app!)
            // Seeded directly (bypassing the per-value 10k cap, which only the application layer
            // enforces) to cheaply cross the 20 MB whole-table cap without 20 MB of individually
            // valid requests. 21 rows x ~1 MB each.
            const oversizedValue = 'x'.repeat(1_000_000)
            await db.save('translation', Array.from({ length: 21 }, (_, i) => ({
                id: apId(),
                projectId: ctx.project.id,
                platformId: ctx.platform.id,
                key: `oversized.${i}`,
                values: { en: oversizedValue },
                description: null,
            })))

            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'one.more.key', values: { en: 'small' } }],
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
        })
    })
})
