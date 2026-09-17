import { inspect } from 'util'
import {
    EngineOperation,
    EngineOperationType,
    EngineResponse,
    EngineResponseStatus,
    ExecuteExtractQadamMetadataOperation,
    ExecuteFlowOperation,
    ExecutePropsOptions,
    ExecuteTriggerOperation,
    ExecuteValidateAuthOperation,
    ExecutionError,
    ExecutionErrorType,
    formatQadamError,
    TriggerHookType,
    tryCatch,
} from '@aiqadam/shared'
import { authValidationOperation } from './auth-validation.operation'
import { flowOperation } from './flow.operation'
import { propertyOperation } from './property.operation'
import { qadamMetadataOperation } from './qadam-metadata.operation'
import { triggerHookOperation } from './trigger-hook.operation'


export async function execute(operationType: EngineOperationType, operation: EngineOperation): Promise<EngineResponse<unknown>> {
    const result = await tryCatch(async () => {
        switch (operationType) {
            case EngineOperationType.EXTRACT_PIECE_METADATA: {
                return qadamMetadataOperation.extract(operation as ExecuteExtractQadamMetadataOperation)
            }
            case EngineOperationType.EXECUTE_FLOW: {
                return flowOperation.execute(operation as ExecuteFlowOperation)
            }
            case EngineOperationType.EXECUTE_PROPERTY: {
                return propertyOperation.execute(operation as ExecutePropsOptions)
            }
            case EngineOperationType.EXECUTE_TRIGGER_HOOK: {
                return triggerHookOperation.execute(operation as ExecuteTriggerOperation<TriggerHookType>)
            }
            case EngineOperationType.EXECUTE_VALIDATE_AUTH: {
                return authValidationOperation.execute(operation as ExecuteValidateAuthOperation)
            }
            default: {
                throw new ExecutionError('Unsupported operation type', `Unsupported operation type: ${operationType}`, ExecutionErrorType.ENGINE)
            }
        }
    })
    if (result.error) {
        // Marker-first: the stderr guard blanks the payload only behind a recognised marker, and
        // a bare error object as the first argument never matches (#403). The full error is still
        // returned below and persisted as the run's internal error.
        console.error('[Engine#executeOperation] Operation failed:', result.error)
        return {
            response: undefined,
            status: EngineResponseStatus.INTERNAL_ERROR,
            error: JSON.stringify(formatQadamError(result.error, { raw: inspect(result.error) })),
        }
    }
    return result.data
}