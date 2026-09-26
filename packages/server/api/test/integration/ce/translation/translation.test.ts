import { apId, DefaultProjectRole, FlowActionType, FlowTrigger, FlowTriggerType, TranslationImportFormat, TranslationImportMode } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { db } from '../../../helpers/db'
import { describeWithAuth } from '../../../helpers/describe-with-auth'
import { createMockFlow, createMockFlowVersion } from '../../../helpers/mocks'
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

        // `assertValuesAreWellFormed` only ever sees a single request's OWN incoming locale count,
        // never the row that results once `"values" || EXCLUDED."values"` merges it into whatever a
        // key already has. Neither this request (5 locales) nor the earlier one that created the key
        // (48 locales) exceeds MAX_TRANSLATION_LOCALES_PER_KEY (50) on its own - only the MERGED row
        // (53) does, and only a post-merge check inside the same transaction can catch that (M5).
        it('rejects a merge that would push a key past MAX_TRANSLATION_LOCALES_PER_KEY, and keeps the existing locales intact', async () => {
            const ctx = await setup()
            const initialValues: Record<string, string> = {}
            for (let i = 0; i < 48; i++) {
                initialValues[`en-x-${i.toString().padStart(4, '0')}`] = 'v'
            }
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'merge.overflow', values: initialValues }],
            })

            const additionalValues: Record<string, string> = {}
            for (let i = 48; i < 53; i++) {
                additionalValues[`en-x-${i.toString().padStart(4, '0')}`] = 'v'
            }
            const response = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'merge.overflow', values: additionalValues }],
            })

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'merge.overflow' })
            expect(Object.keys(list.json().data[0].values)).toHaveLength(48)
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

        it('treats "_" in the search term literally rather than as a single-character wildcard', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [
                    { key: 'wild_card.test', values: { en: 'a' } },
                    { key: 'wildXcard.test', values: { en: 'b' } },
                ],
            })

            const response = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'wild_card' })
            expect(response.statusCode).toBe(StatusCodes.OK)
            const keys = response.json().data.map((row: { key: string }) => row.key)
            expect(keys).toEqual(['wild_card.test'])
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

        // A nested payload accidentally sent with `format: 'flat'` has object values, not strings —
        // silently skipping them used to mean an existing key kept nothing from this import, so
        // `mode: 'replace'` would strip its `en` locale entirely (M4). Rejecting the whole request
        // up front, before the transaction opens, means nothing is deleted.
        it('rejects a nested payload sent as format: flat + replace, deleting nothing (M4)', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'greeting', values: { en: 'Hello', ru: 'Привет' } }],
            })

            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.FLAT,
                mode: TranslationImportMode.REPLACE,
                data: { greeting: { nested: 'oops' } },
            })
            expect(response.statusCode).toBe(StatusCodes.CONFLICT)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'greeting' })
            expect(list.json().data[0].values).toEqual({ en: 'Hello', ru: 'Привет' })
        })

        it('rejects a non-string leaf in a nested payload (M4)', async () => {
            const ctx = await setup()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.NESTED,
                mode: TranslationImportMode.MERGE,
                data: { nested: { count: 42 } },
            })
            expect(response.statusCode).toBe(StatusCodes.CONFLICT)

            const list = await ctx.get('/v1/translations', { projectId: ctx.project.id, key: 'nested.count' })
            expect(list.json().data).toHaveLength(0)
        })

        // `nextPrefix.length > TRANSLATION_KEY_MAX_LENGTH` is checked the instant a child segment
        // would be appended, before ever recursing into it — a chain of 150 single-letter levels
        // crosses 255 characters around level 128. This does NOT distinguish old from new code by
        // status code alone: the pre-fix walker also eventually rejects the same (fully-built,
        // over-length) key via the post-hoc `assertKeyIsWellFormed` check that already ran on every
        // flattened key before this round, so both old and new code return 409 here. What only the
        // eager per-segment check produces is THIS specific message, thrown mid-walk rather than
        // after flattening completes — the pre-fix code's post-hoc rejection reads
        // `"<key>" is not a valid translation key`, never the "exceeds ... characters" wording below.
        it('rejects a nested key path once it would exceed TRANSLATION_KEY_MAX_LENGTH (M4)', async () => {
            const ctx = await setup()
            const letters = 'abcdefghijklmnopqrstuvwxyz'
            let node: unknown = 'leaf'
            for (let i = 0; i < 150; i++) {
                node = { [letters[i % letters.length]]: node }
            }

            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.NESTED,
                mode: TranslationImportMode.MERGE,
                data: node,
            })

            expect(response.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response.json().params.message).toContain('exceeds 255 characters')
        })

        // A deep chain of long (50-char) segments crosses TRANSLATION_KEY_MAX_LENGTH within the
        // chain itself, a handful of levels before ever reaching the wide leaf object below it — the
        // eager per-segment length check (this fix) aborts there, in well under a millisecond,
        // without ever touching the wide object's 2,000 entries (deliberately kept under the
        // pre-existing 5,000-key cap, so THAT cap can't be what's rejecting this payload and mask the
        // fix under test). The pre-fix `[...prefix, segment]` walker has no such short-circuit: it
        // walks the whole chain, then the wide object, building one ~24,000-character joined key per
        // entry via `prefix.join('.')` and calling `Object.defineProperty` with that key 2,000 times —
        // a standalone reproduction of this exact shape (see bench-old-new.mjs in this PR's history)
        // measured that at ~4 seconds, entirely from Object.defineProperty's own non-linear cost on
        // very long string keys, not from the array-copy cost of building the prefix itself. Both old
        // and new code end up returning 409 (the payload's over-length keys are invalid either way),
        // so status code alone can't tell them apart — the elapsed-time budget is what a regression
        // here would blow.
        it('rejects a deep chain leading to a wide leaf object fast, staying under 1 MB (M4)', async () => {
            const ctx = await setup()
            const segment = 's'.repeat(50)
            const wide: Record<string, string> = {}
            for (let i = 0; i < 2_000; i++) {
                Object.defineProperty(wide, `k${i}`, { value: '1', writable: true, enumerable: true, configurable: true })
            }
            let node: Record<string, unknown> = wide
            for (let i = 0; i < 470; i++) {
                node = { [`${segment}${i}`]: node }
            }

            const startedAt = Date.now()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.NESTED,
                mode: TranslationImportMode.MERGE,
                data: node,
            })
            const elapsedMs = Date.now() - startedAt

            expect(response.statusCode).toBe(StatusCodes.CONFLICT)
            expect(response.json().params.message).toContain('exceeds 255 characters')
            expect(elapsedMs).toBeLessThan(2_000)
        })

        // A payload built entirely from same-depth empty objects never reaches a leaf at all, so
        // neither the key-count cap NOR the non-string-leaf rejection above is ever triggered — the
        // node-visit cap is the ONLY thing that bounds this walk. 55,000 empty-object entries (each
        // the cheapest possible per-node JSON encoding) cross MAX_TRANSLATION_IMPORT_NODES (50,000)
        // while staying comfortably under the 1 MB byte cap.
        it('rejects a payload of nested empty objects once the node-visit cap is exceeded, even though no leaf is ever invalid (M4)', async () => {
            const ctx = await setup()
            const data: Record<string, unknown> = {}
            for (let i = 0; i < 55_000; i++) {
                Object.defineProperty(data, String(i), { value: {}, writable: true, enumerable: true, configurable: true })
            }

            const startedAt = Date.now()
            const response = await ctx.post('/v1/translations/import', {
                projectId: ctx.project.id,
                locale: 'en',
                format: TranslationImportFormat.NESTED,
                mode: TranslationImportMode.MERGE,
                data,
            })
            const elapsedMs = Date.now() - startedAt

            expect(response.statusCode).toBe(StatusCodes.FORBIDDEN)
            expect(elapsedMs).toBeLessThan(10_000)
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
            expect(flat.json().translations['export.key']).toBe('Exported')

            const nested = await ctx.get('/v1/translations/export', { projectId: ctx.project.id, locale: 'en', format: TranslationImportFormat.NESTED })
            expect(nested.json().translations.export.key).toBe('Exported')
        })

        // A translation key is flow-author-controlled text — a key literally named "projectId"
        // must not collide with anything at the response's own top level (M9). Wrapped in
        // { translations: ... }, it is just an ordinary entry inside that object.
        it('exports a key literally named "projectId" without colliding with the response envelope', async () => {
            const ctx = await setup()
            await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'projectId', values: { en: 'not the real project id' } }],
            })

            const response = await ctx.get('/v1/translations/export', { projectId: ctx.project.id, locale: 'en' })

            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().translations.projectId).toBe('not the real project id')
        })
    })

    describeWithAuth('GET /v1/translations/:id/usages (M7)', () => app!, (setup) => {
        it('reports a flow whose draft references the key, and one whose published version does, separately', async () => {
            const ctx = await setup()
            const created = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'usage.key', values: { en: 'Used' } }],
            })
            const id = created.json()[0].id

            const draftOnlyFlow = createMockFlow({ projectId: ctx.project.id })
            await db.save('flow', draftOnlyFlow)
            await db.save('flow_version', createMockFlowVersion({
                flowId: draftOnlyFlow.id,
                displayName: 'Draft Only Flow',
                trigger: buildTriggerReferencing('{{$t[\'usage.key\']}}'),
            }))

            // Two versions on the same flow: the older one (published) references the key, and a
            // newer, never-published draft that does not — proving the endpoint reports draft and
            // published usage independently rather than treating "has any version referencing it"
            // as a single flag. A flow's own latest version is otherwise indistinguishable from its
            // published one whenever it has only ever had a single version.
            const publishedFlow = createMockFlow({ projectId: ctx.project.id })
            await db.save('flow', publishedFlow)
            const publishedVersion = createMockFlowVersion({
                flowId: publishedFlow.id,
                displayName: 'Published Flow',
                created: new Date(Date.now() - 60_000).toISOString(),
                trigger: buildTriggerReferencing('{{$t[\'usage.key\']}}'),
            })
            await db.save('flow_version', publishedVersion)
            await db.update('flow', publishedFlow.id, { publishedVersionId: publishedVersion.id })
            await db.save('flow_version', createMockFlowVersion({
                flowId: publishedFlow.id,
                displayName: 'Published Flow (newer draft)',
                created: new Date().toISOString(),
                trigger: buildTriggerReferencing('plain text, no reference'),
            }))

            const untouchedFlow = createMockFlow({ projectId: ctx.project.id })
            await db.save('flow', untouchedFlow)
            await db.save('flow_version', createMockFlowVersion({
                flowId: untouchedFlow.id,
                displayName: 'Unrelated Flow',
                trigger: buildTriggerReferencing('{{$t[\'other.key\']}}'),
            }))

            const response = await ctx.get(`/v1/translations/${id}/usages`)
            expect(response.statusCode).toBe(StatusCodes.OK)
            const body = response.json()
            expect(body.key).toBe('usage.key')

            const byFlowId = new Map(body.usages.map((usage: { flowId: string }) => [usage.flowId, usage]))
            expect(byFlowId.get(draftOnlyFlow.id)).toMatchObject({ referencedInDraft: true, referencedInPublished: false })
            expect(byFlowId.get(publishedFlow.id)).toMatchObject({ referencedInDraft: false, referencedInPublished: true })
            expect(byFlowId.has(untouchedFlow.id)).toBe(false)
        })

        it('reports no usages for a key nothing references', async () => {
            const ctx = await setup()
            const created = await ctx.post('/v1/translations', {
                projectId: ctx.project.id,
                translations: [{ key: 'unused.key', values: { en: 'Unused' } }],
            })
            const id = created.json()[0].id

            const response = await ctx.get(`/v1/translations/${id}/usages`)
            expect(response.statusCode).toBe(StatusCodes.OK)
            expect(response.json().usages).toEqual([])
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
            // enforces) to cheaply cross the 4 MB whole-table cap without needing that many
            // individually valid requests. 21 rows x ~1 MB each is comfortably over the cap either
            // way, so this test needs no adjustment when the cap's own value changes.
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

function buildTriggerReferencing(input: string): FlowTrigger {
    return {
        name: 'trigger',
        displayName: 'Trigger',
        valid: true,
        lastUpdatedDate: new Date().toISOString(),
        type: FlowTriggerType.EMPTY,
        settings: {},
        nextAction: {
            name: 'step_1',
            displayName: 'Step 1',
            valid: true,
            lastUpdatedDate: new Date().toISOString(),
            type: FlowActionType.PIECE,
            settings: {
                qadamName: '@aiqadam/qadam-data-mapper',
                qadamVersion: '0.4.14',
                actionName: 'advanced_mapping',
                input: { text: input },
                propertySettings: {},
            },
        },
    }
}
