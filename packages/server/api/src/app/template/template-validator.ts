import { ErrorCode, FlowOperationRequest, flowOperations, FlowOperationType, flowQadamUtil, FlowVersion, FlowVersionState, FlowVersionTemplate, PlatformId, QadamFlowError, sanitizeObjectForPostgresql } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { flowVersionValidationUtil } from '../flows/flow-version/flow-version-validator-util'

function createMinimalFlowVersion(template: FlowVersionTemplate): FlowVersion {
    return {
        ...template,
        id: 'temp-id',
        flowId: 'temp-flow-id',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        state: FlowVersionState.DRAFT,
        updatedBy: null,
        agentIds: [],
        connectionIds: [],
        backupFiles: null,
        notes: template.notes ?? [],
    }
}

type PreparedTemplate = {
    flows: FlowVersionTemplate[]
    qadams: string[]
}

export const templateValidator = {
    async validateAndPrepare({ flows, platformId, log }: ValidateParams): Promise<PreparedTemplate> {
        if (!flows || flows.length === 0) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'Flows are required',
                },
            })
        }
        
        await Promise.all(flows.map(async (flow) => {
            const minimalFlowVersion = createMinimalFlowVersion(flow)
            
            const importRequest = {
                displayName: flow.displayName,
                trigger: flow.trigger,
                schemaVersion: flow.schemaVersion,
            }

            const importOperation: FlowOperationRequest = { 
                type: FlowOperationType.IMPORT_FLOW, 
                request: importRequest, 
            }

            const validator = flowVersionValidationUtil(log)

            await validator.prepareRequest({ platformId, request: importOperation, userId: null })
            
            flowOperations.apply(minimalFlowVersion, importOperation)
        }))

        const sanitizedFlows = flows.map((flow) => sanitizeObjectForPostgresql(flow))
        const qadams = Array.from(new Set(sanitizedFlows.map((flow) => flowQadamUtil.getUsedQadams(flow.trigger)).flat()))

        return {
            flows: sanitizedFlows,
            qadams,
        }
    },
}

type ValidateParams = {
    flows: FlowVersionTemplate[] | undefined
    platformId?: PlatformId
    log: FastifyBaseLogger
}