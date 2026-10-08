import { assertNotNullOrUndefined, FrameworkCensusResponse, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { frameworkCensusPolicy } from './framework-census-policy'
import { frameworkCensusService } from './framework-census-service'

// The admin surface of the ADR-0002 census (#803): the platform's own steps, with the context
// version each pinned qadam needs and whether this release still runs it. Read-only, and scoped to
// the caller's platform.
export const frameworkCensusController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', GetFrameworkCensusRequest, async (req) => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        const census = await frameworkCensusService(req.log).censusOfPlatform({ platformId })
        return {
            engine: {
                frameworkMajor: frameworkCensusPolicy.currentFrameworkMajor(),
                contextVersions: [...frameworkCensusPolicy.engineContextVersions()],
            },
            retiredContextVersions: frameworkCensusPolicy.retiredContextVersions(),
            summary: census.summary,
            unreadableVersions: census.unreadableVersions,
            steps: census.steps,
        }
    })
}

const GetFrameworkCensusRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        response: {
            [StatusCodes.OK]: FrameworkCensusResponse,
        },
    },
}
