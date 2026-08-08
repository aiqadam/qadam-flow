import { PrincipalType } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { securityAccess } from '../../core/security/authorization/fastify-security'
import { redisConnections } from '../../database/redis-connections'
import { triggerRunStats } from './trigger-run-stats'

export const triggerRunController: FastifyPluginAsyncZod = async (app) => {
    app.get('/status', GetStatusReportSchema, async (request) => {
        const platformId = request.principal.platform.id
        return triggerRunStats(app.log, await redisConnections.useExisting()).getStatusReport({ platformId })
    })
}

// Platform-admin only. The report aggregates every trigger execution on the platform — per-qadam
// success and failure counts across all projects, which names the third-party integrations other
// teams run and how badly they are failing. Its only caller is the platform Trigger Health page
// (`packages/web/src/app/routes/platform/infra/triggers/index.tsx`), which `PlatformLayout` already
// gates on `useIsPlatformAdmin()` — so the previous `publicPlatform` was a client-side-only gate:
// `publicPlatform` checks the principal's *type* and nothing else (`authorize.ts`), leaving the
// route readable by any authenticated platform user, embedded JWT users included.
const GetStatusReportSchema = {
    config: {
        security: securityAccess.platformAdminOnly([PrincipalType.USER]),
    },
}