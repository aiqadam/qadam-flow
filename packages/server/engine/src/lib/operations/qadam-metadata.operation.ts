import { QadamMetadata } from '@aiqadam/qadams-framework'
import {
    EngineResponse,
    EngineResponseStatus,
    ExecuteExtractQadamMetadataOperation,
} from '@aiqadam/shared'
import { EngineConstants } from '../handler/context/engine-constants'
import { qadamHelper } from '../helper/qadam-helper'


export const qadamMetadataOperation = {
    extract: async (operation: ExecuteExtractQadamMetadataOperation): Promise<EngineResponse<QadamMetadata>>  => {
        const input = operation as ExecuteExtractQadamMetadataOperation
        const output = await qadamHelper.extractQadamMetadata({
            params: input,
            devQadams: EngineConstants.DEV_QADAMS,
        })
        return {
            status: EngineResponseStatus.OK,
            response: output,
        }
    },
}