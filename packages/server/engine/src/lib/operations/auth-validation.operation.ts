import {
    EngineResponse,
    EngineResponseStatus,
    ExecuteValidateAuthOperation,
    ExecuteValidateAuthResponse,
} from '@aiqadam/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import { qadamHelper } from '../helper/qadam-helper'

export const authValidationOperation = {
    execute: async (operation: ExecuteValidateAuthOperation): Promise<EngineResponse<ExecuteValidateAuthResponse>> => {
        const input = operation as ExecuteValidateAuthOperation
        const output = await qadamHelper.executeValidateAuth({
            params: input,
            devQadams: EngineConstants.DEV_QADAMS,
        })

        return {
            status: EngineResponseStatus.OK,
            response: output,
        }
    },
}