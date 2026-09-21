import { FlowActionType, flowStructureUtil, FlowTriggerType, FlowVersion, isEmpty, isNil, ProjectId, tryCatch } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowService } from '../../flow/flow.service'

export const flowMigrationUtil = {
    // Derived here rather than read from `MigrationContext.projectId`, for the same reason
    // `migrate-v31` derives its own platform instead of trusting the context: the context is
    // optional and `migrateFlowVersionTemplate` invokes the chain without one, so a migration that
    // relied on it would silently do nothing on the template-import path — which is precisely the
    // path an untrusted `field.id` arrives on.
    //
    // Every step is wrapped in `tryCatch` deliberately. `flow-version-migration.service.ts` pages
    // on-call on any throw from the chain, and on the template-import path the flow may not exist
    // in the database at all, so "cannot determine the project" is a normal outcome here and must
    // degrade rather than fail. Callers are expected to treat `undefined` as "resolve nothing",
    // never as "resolve across every project".
    // `flowVersionId` is carried for the log line alone: it is the handle an operator needs to
    // answer "which flow versions degraded", and `flowId` cannot answer it — the degrade is
    // recorded per version, and a flow has many.
    async resolveProjectId({ flowId, flowVersionId, log }: { flowId: string, flowVersionId: string, log: FastifyBaseLogger }): Promise<ProjectId | undefined> {
        const { data: flow, error } = await tryCatch(() => flowService(log).getOneById(flowId))
        if (!isNil(flow)) {
            return flow.projectId
        }

        // The degrade is PERMANENT and has to leave a trace. `flowVersionMigrationService.migrate`
        // persists the bumped `schemaVersion` either way, and the chain only re-enters a migration
        // whose `targetSchemaVersion` equals the version in hand — so a flow version that degraded
        // here is stamped migrated forever with its field ids never resolved. Before this filter
        // existed a transient database error propagated and paged someone; without this log it
        // would become a silent, unrepeatable no-op instead, which is a worse trade than the one
        // the degrade is meant to make. `migrate-v31` logs its equivalent for the same reason.
        //
        // Split by cause because one of the two is routine: `migrateFlowVersionTemplate` invokes
        // the chain with `flowId: ''` on every template import by design, so warning on that would
        // train the reader to ignore the line that matters.
        const logContext = { flowId, flowVersionId, err: error }
        if (isEmpty(flowId)) {
            log.debug(logContext, '[resolveProjectId] no flow to resolve a project from — template migration path, ids left as authored')
            return undefined
        }
        log.warn(logContext, '[resolveProjectId] could not determine the project for this flow; field ids are left unresolved and this flow version will not be revisited')
        return undefined
    },

    pinPieceToVersion(flowVersion: FlowVersion, qadamName: string, qadamVersion: string) {
        const newVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            if ((step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE) && step.settings.qadamName === qadamName) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion,
                    },
                }
            }
            return step
        })
        return newVersion
    },
}