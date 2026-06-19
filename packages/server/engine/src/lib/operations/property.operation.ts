import { ExecutePropsResult, PropertyType } from '@aiqadam/qadams-framework'
import {
    EngineResponse,
    EngineResponseStatus,
    ExecutePropsOptions,
} from '@aiqadam/shared'
import { qadamHelper } from '../helper/qadam-helper'


export const propertyOperation = {
    execute: async (operation: ExecutePropsOptions): Promise<EngineResponse<ExecutePropsResult<PropertyType.DROPDOWN | PropertyType.MULTI_SELECT_DROPDOWN | PropertyType.DYNAMIC>>> => {
        const output = await qadamHelper.executeProps({
            ...operation,
            qadamName: operation.qadam.qadamName,
            qadamVersion: operation.qadam.qadamVersion,
        })
        return {
            status: EngineResponseStatus.OK,
            response: output,
        }
    },
}