import { DefaultProjectRole, TranslationImportFormat, TranslationImportMode } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
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
})
