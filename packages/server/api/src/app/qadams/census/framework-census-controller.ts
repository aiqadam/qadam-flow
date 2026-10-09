import { assertNotNullOrUndefined, FrameworkCensusResponse, PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { StatusCodes } from 'http-status-codes'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { frameworkCensusCache } from './framework-census-cache'
import { frameworkCensusPolicy } from './framework-census-policy'
import { frameworkCensusService } from './framework-census-service'

// The admin surface of the ADR-0002 census (#803): the platform's own steps, with the context
// version each pinned qadam needs and whether this release still runs it. Read-only, and scoped to
// the caller's platform.
export const frameworkCensusController: FastifyPluginAsyncZod = async (app) => {
    app.get('/', GetFrameworkCensusRequest, async (req): Promise<FrameworkCensusResponse> => {
        const platformId = req.principal.platform.id
        assertNotNullOrUndefined(platformId, 'platformId')

        const engine = {
            frameworkMajor: frameworkCensusPolicy.currentFrameworkMajor(),
            contextVersions: [...frameworkCensusPolicy.engineContextVersions()],
        }
        // The census walks every flow of the platform. Until a release retires a context version no
        // step can be unsupported, which is all this surface reports, so it skips the walk — the
        // normal state, and the one every visit to the Health page hits.
        if (!frameworkCensusPolicy.hasRetiredContextVersion()) {
            return {
                engine,
                retiredContextVersions: [],
                ran: false,
                summary: { current: 0, legacy: 0, unsupported: 0, flowsWithUnsupportedSteps: 0 },
                unreadableVersions: 0,
                totalSteps: 0,
                steps: [],
            }
        }

        // A walk of every flow of the platform: served from the per-platform cache, one walk per
        // process per TTL, shared by concurrent requests (`framework-census-cache.ts`).
        const census = await frameworkCensusCache.ofPlatform({
            platformId,
            compute: () => frameworkCensusService(req.log).censusOfPlatform({ platformId, maxSteps: MAX_STEPS }),
        })
        return {
            engine,
            retiredContextVersions: frameworkCensusPolicy.retiredContextVersions(),
            ran: true,
            summary: census.summary,
            unreadableVersions: census.unreadableVersions,
            totalSteps: census.totalSteps,
            steps: census.steps,
        }
    })
}

// The banner names a handful of flows and the summary carries the counts; the full list of a large
// platform is the `doctor`'s output, not a response body.
const MAX_STEPS = 200

const GetFrameworkCensusRequest = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
    schema: {
        tags: ['framework-census'],
        response: {
            [StatusCodes.OK]: FrameworkCensusResponse,
        },
    },
}
