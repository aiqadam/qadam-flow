import {
    assertNotNullOrUndefined,
    EnginePrincipal,
    GetTranslationsForWorkerResponse,
} from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../core/security/authorization/fastify-security'
import { translationService } from './translation.service'

// The response is a map (`{ translations: [...] }`), not a single/array-of-entities shape the
// `entitiesMustBeOwnedByCurrentProject` preSerialization hook can walk — so this route does its own
// project scoping explicitly, straight from the engine principal, rather than relying on that hook.
// See test/integration/ce/translation/translation-worker.test.ts for the cross-project isolation
// proof.
export const translationWorkerController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', GetTranslationsForWorkerRequest, async (request): Promise<GetTranslationsForWorkerResponse> => {
        const enginePrincipal = (request.principal as EnginePrincipal)
        assertNotNullOrUndefined(enginePrincipal.projectId, 'projectId')
        const rows = await translationService(request.log).listForWorker({ projectId: enginePrincipal.projectId })
        return {
            translations: rows.map((row) => ({ key: row.key, values: row.values })),
        }
    })
}

const GetTranslationsForWorkerRequest = {
    config: {
        security: securityAccess.engine(),
    },
    schema: {
        response: {
            [StatusCodes.OK]: GetTranslationsForWorkerResponse,
        },
    },
}
