import {
    FlowId,
    FlowStatus,
    FlowVersionId,
    isNil,
    ProjectId,
    tryCatch,
} from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { triggerSourceService } from '../../trigger/trigger-source/trigger-source-service'
import { flowVersionService } from '../flow-version/flow-version.service'
import { flowExecutionCache } from './flow-execution-cache'
import { flowRepo } from './flow.repo'

/**
 * Puts a flow back to the status and published version it had before a publish whose trigger could
 * not be re-registered (#781). `LOCK_AND_PUBLISH` swaps `publishedVersionId` and flips the flow to
 * DISABLED before the trigger is enabled, so without this a failed ON_ENABLE — a pin this image
 * cannot resolve — would leave a flow that was enabled stuck at DISABLED.
 *
 * Best-effort by design: the caller rethrows the original publish error, so nothing here may throw.
 * When the previous trigger is re-registered the row goes back to its previous status; when it is
 * not, the row stays DISABLED and the trigger source the failed publish left behind is removed, so
 * the flow never claims ENABLED (or keeps running) with nothing registered (#432).
 */
export async function restoreFlowAfterFailedPublish({
    flowId,
    projectId,
    previousStatus,
    previousPublishedVersionId,
    log,
}: RestoreFlowAfterFailedPublishParams): Promise<void> {
    let triggerRestored = false
    const { error: triggerError } = await tryCatch(async () => {
        if (previousStatus !== FlowStatus.ENABLED) {
            return
        }
        if (isNil(previousPublishedVersionId)) {
            // An enabled flow always has a published version in practice; if it somehow does not,
            // there is nothing to re-register, so it cannot be left reading ENABLED below.
            log.warn({ flowId, projectId }, '[restoreFlowAfterFailedPublish] The flow was enabled but has no previous published version to re-register')
            return
        }
        const previousVersion = await flowVersionService(log).getFlowVersionOrThrow({
            flowId,
            versionId: previousPublishedVersionId,
            projectId,
        })
        // Re-enabling also replaces the trigger source the failed enable left behind for the new
        // version: `enable` soft-deletes the flow's current trigger source before it registers one.
        await triggerSourceService(log).enable({
            flowVersion: previousVersion,
            projectId,
            simulate: false,
        })
        triggerRestored = true
    })
    if (!isNil(triggerError)) {
        log.error(
            { flowId, projectId, previousPublishedVersionId, error: String(triggerError) },
            '[restoreFlowAfterFailedPublish] Could not restore the previous published version trigger',
        )
    }

    if (!triggerRestored) {
        // The flow is not running the previous trigger, so nothing should be registered or polled:
        // remove whatever trigger source the failed publish left behind.
        const { error: cleanupError } = await tryCatch(() => triggerSourceService(log).disable({
            flowId,
            projectId,
            simulate: false,
            ignoreError: true,
        }))
        if (!isNil(cleanupError)) {
            log.error(
                { flowId, projectId, error: String(cleanupError) },
                '[restoreFlowAfterFailedPublish] Could not remove the trigger source left by the failed publish',
            )
        }
    }

    const { error: persistError } = await tryCatch(async () => {
        await flowRepo().update({ id: flowId, projectId }, {
            // ENABLED only when the previous trigger was actually re-registered; otherwise DISABLED, so
            // the flow never reads ENABLED while no webhook is registered and nothing is polled (#432).
            status: triggerRestored ? previousStatus : FlowStatus.DISABLED,
            publishedVersionId: previousPublishedVersionId,
        })
        await flowExecutionCache(log).invalidate(flowId)
    })
    if (!isNil(persistError)) {
        log.error(
            { flowId, projectId, error: String(persistError) },
            '[restoreFlowAfterFailedPublish] Could not restore the flow status and published version',
        )
    }
}

type RestoreFlowAfterFailedPublishParams = {
    flowId: FlowId
    projectId: ProjectId
    previousStatus: FlowStatus
    previousPublishedVersionId: FlowVersionId | null
    log: FastifyBaseLogger
}
