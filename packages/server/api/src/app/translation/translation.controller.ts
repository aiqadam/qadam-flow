import {
    ApId,
    ErrorCode,
    ExportTranslationsRequestQuery,
    GetTranslationUsagesResponse,
    ImportTranslationsRequestBody,
    ListTranslationsRequestQuery,
    MAX_TRANSLATION_IMPORT_BYTES,
    Permission,
    PrincipalType,
    QadamFlowError,
    SeekPage,
    SERVICE_KEY_SECURITY_OPENAPI,
    Translation,
    TranslationImportFormat,
    UpsertTranslationsRequestBody,
} from '@aiqadam/shared'
import { RateLimitOptions } from '@fastify/rate-limit'
import { FastifyPluginCallbackZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { z } from 'zod'
import { ProjectResourceType } from '../core/security/authorization/common'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'
import { TranslationEntity } from './translation.entity'
import { translationService } from './translation.service'

// Reuses the operator-configured API_RATE_LIMIT_AUTHN_* knobs rather than inventing a
// translation-specific one — the same pattern `user-invitation.module.ts` follows for its own
// non-authn write route. Import is the one translation write whose cost scales with request size
// (the transactional per-project write below, plus the whole-table byte-cap scan), so it is the
// one that needs its own per-route limit; the others are bounded by their own item/key caps.
const importRateLimitOptions: RateLimitOptions = {
    max: Number.parseInt(system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_MAX), 10),
    timeWindow: system.getOrThrow(AppSystemProp.API_RATE_LIMIT_AUTHN_WINDOW),
}

export const translationController: FastifyPluginCallbackZod = (app, _opts, done) => {
    app.get('/', ListTranslationsRequest, async (request): Promise<SeekPage<Translation>> => {
        return translationService(request.log).list({
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            cursor: request.query.cursor,
            limit: request.query.limit,
            key: request.query.key,
        })
    })

    app.post('/', UpsertTranslationsRequest, async (request) => {
        return translationService(request.log).upsertBatch({
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            items: request.body.translations,
        })
    })

    app.delete('/:id', DeleteTranslationRequest, async (request, reply): Promise<void> => {
        await translationService(request.log).delete({
            id: request.params.id,
            projectId: request.projectId,
            platformId: request.principal.platform.id,
        })
        await reply.status(StatusCodes.NO_CONTENT).send()
    })

    app.get('/:id/usages', GetTranslationUsagesRequest, async (request) => {
        return translationService(request.log).usages({
            id: request.params.id,
            projectId: request.projectId,
            platformId: request.principal.platform.id,
        })
    })

    app.post('/import', ImportTranslationsRequest, async (request) => {
        assertWithinImportSizeCap(request.body.data)
        return translationService(request.log).import({
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            locale: request.body.locale,
            format: request.body.format,
            mode: request.body.mode,
            data: request.body.data,
        })
    })

    app.get('/export', ExportTranslationsRequest, async (request) => {
        return translationService(request.log).exportAll({
            projectId: request.projectId,
            platformId: request.principal.platform.id,
            locale: request.query.locale,
            format: request.query.format ?? TranslationImportFormat.FLAT,
        })
    })

    done()
}

function assertWithinImportSizeCap(data: Record<string, unknown>): void {
    const byteSize = Buffer.byteLength(JSON.stringify(data), 'utf8')
    if (byteSize > MAX_TRANSLATION_IMPORT_BYTES) {
        throw new QadamFlowError({
            code: ErrorCode.VALIDATION,
            params: { message: `Import payload is ${byteSize} bytes, exceeding the ${MAX_TRANSLATION_IMPORT_BYTES}-byte cap` },
        })
    }
}

const ListTranslationsRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_TRANSLATION,
            { type: ProjectResourceType.QUERY },
        ),
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        querystring: ListTranslationsRequestQuery,
        description: 'List project translations, filterable by a key substring',
        response: {
            [StatusCodes.OK]: SeekPage(Translation),
        },
    },
}

const UpsertTranslationsRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_TRANSLATION,
            { type: ProjectResourceType.BODY },
        ),
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Batch upsert-by-key. Existing locales on a key are merged with the ones sent, never replaced wholesale.',
        body: UpsertTranslationsRequestBody,
        response: {
            [StatusCodes.OK]: z.array(Translation),
        },
    },
}

const DeleteTranslationRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_TRANSLATION,
            { type: ProjectResourceType.TABLE, tableName: TranslationEntity },
        ),
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Delete a translation key',
        params: z.object({ id: ApId }),
        response: {
            [StatusCodes.NO_CONTENT]: z.never(),
        },
    },
}

const GetTranslationUsagesRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_TRANSLATION,
            { type: ProjectResourceType.TABLE, tableName: TranslationEntity },
        ),
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Find flows in this project whose draft or published version references this translation key, bounded by MAX_TRANSLATION_USAGE_FLOWS_SCANNED. Used to warn before deleting a key still in use.',
        params: z.object({ id: ApId }),
        response: {
            [StatusCodes.OK]: GetTranslationUsagesResponse,
        },
    },
}

const ImportTranslationsRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.WRITE_TRANSLATION,
            { type: ProjectResourceType.BODY },
        ),
        rateLimit: importRateLimitOptions,
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Import translations for a single locale. `mode: "replace"` removes that locale\'s entries from keys not present in the payload; every other locale on every key is untouched.',
        body: ImportTranslationsRequestBody,
        response: {
            [StatusCodes.OK]: z.object({ importedKeys: z.number(), removedFromLocale: z.number() }),
        },
    },
}

const ExportTranslationsRequest = {
    config: {
        security: securityAccess.project(
            [PrincipalType.USER, PrincipalType.SERVICE],
            Permission.READ_TRANSLATION,
            { type: ProjectResourceType.QUERY },
        ),
    },
    schema: {
        tags: ['translations'],
        security: [SERVICE_KEY_SECURITY_OPENAPI],
        description: 'Export all translations for one locale as flat ({"a.b": "value"}) or nested ({"a": {"b": "value"}}) JSON',
        querystring: ExportTranslationsRequestQuery,
        response: {
            // Wrapped, not a bare `z.record(...)`: a translation key is flow-author-controlled
            // text, and an unwrapped response body is indistinguishable from any other top-level
            // property a caller or downstream middleware might expect — a key literally named
            // "projectId" (or any other field this API's response shapes otherwise carry) could
            // collide. Naming the envelope means no translation key ever can.
            [StatusCodes.OK]: z.object({ translations: z.record(z.string(), z.unknown()) }),
        },
    },
}
