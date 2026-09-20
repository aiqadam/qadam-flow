import {
    flowQadamUtil,
    flowStructureUtil,
    FlowVersion,
    isNil,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { qadamPinUtil } from '../../../qadams/metadata/qadam-pin-util'
import { flowService } from '../../flow/flow.service'
import { Migration } from '.'

export const migrateV19StripPieceVersionWildcards: Migration = {
    targetSchemaVersion: '19',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        const log = system.globalLogger()
        const flow = await flowService(log).getOneById(flowVersion.flowId)
        const platformId = isNil(flow)
            ? undefined
            : await projectService(log).getPlatformId(flow.projectId)

        // A `Map`, not a `Record`: `transferFlow` below calls its callback for EVERY step, not only
        // the rewritten ones, and a step name is only checked against `STEP_NAME_REGEX`
        // (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`), which admits `constructor`, `toString`, `hasOwnProperty`,
        // `__proto__` — names that survive `ap_import_flow` verbatim. A bare `Record` index on one
        // of those reaches `Object.prototype` and would hand back a function (or, for `__proto__`,
        // an object) as the "exact version", which `isNil` happily lets through. Same idiom as the
        // `hasOwn`, not a bare index guard in `ap-validate-flow.ts`'s delay-unit lookup.
        const stepNameToExactVersion = new Map<string, string>()
        const wildcardSteps = qadamPinUtil.getQadamSteps({ trigger: flowVersion.trigger })
            .filter(step => step.settings.qadamVersion.startsWith('~') || step.settings.qadamVersion.startsWith('^'))

        for (const step of wildcardSteps) {
            const resolvedVersion = await qadamPinUtil.resolvePinVersion({
                platformId,
                name: step.settings.qadamName,
                version: step.settings.qadamVersion,
                log,
            })
            stepNameToExactVersion.set(step.name, resolvedVersion ?? flowQadamUtil.getExactVersion(step.settings.qadamVersion))
        }

        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            const exactVersion = stepNameToExactVersion.get(step.name)
            if (isNil(exactVersion)) {
                return step
            }
            return {
                ...step,
                settings: {
                    ...step.settings,
                    qadamVersion: exactVersion,
                },
            }
        })

        return {
            ...newFlowVersion,
            schemaVersion: '20',
        }
    },
}
