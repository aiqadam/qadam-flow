import { ContextVersion, PropertyContext } from '@aiqadam/qadams-framework'
import { EngineConstants } from '../handler/context/engine-constants'
import { utils } from '../utils'
import { createFlowsContext } from './flows'

// One builder for the context a property's `options()` / `props()` sees, so the builder's
// executeProps and the run-time schema computation for DYNAMIC props (#388) cannot drift apart:
// a `props()` that resolved one way in the form and another at run time would process the
// sub-fields against a schema the user never saw.
export const createPropertyContext = ({ constants, stepName, contextVersion, searchValue }: CreatePropertyContextParams): PropertyContextWithStep => ({
    searchValue,
    server: {
        token: constants.engineToken,
        apiUrl: constants.internalApiUrl,
        publicUrl: constants.publicApiUrl,
    },
    project: {
        id: constants.projectId,
        externalId: constants.externalProjectId,
    },
    flows: createFlowsContext(constants),
    step: {
        name: stepName,
    },
    connections: utils.createConnectionManager({
        projectId: constants.projectId,
        engineToken: constants.engineToken,
        apiUrl: constants.internalApiUrl,
        target: 'properties',
        contextVersion,
    }),
})

type CreatePropertyContextParams = {
    constants: EngineConstants
    stepName: string
    contextVersion: ContextVersion | undefined
    searchValue?: string
}

type PropertyContextWithStep = PropertyContext & {
    step: {
        name: string
    }
}
