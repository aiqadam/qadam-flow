import {
    FlowActionType,
    flowStructureUtil,
    FlowTriggerType,
    FlowVersion,
    FlowVersionState,
    isNil,
    tryCatch,
} from '@aiqadam/shared'
import { system } from '../../../helper/system/system'
import { projectService } from '../../../project/project-service'
import { qadamMetadataService } from '../../../qadams/metadata/qadam-metadata-service'
import { flowService } from '../../flow/flow.service'
import { Migration } from '.'

export const migrateV12FixPieceVersion: Migration = {
    targetSchemaVersion: '12',
    migrate: async (flowVersion: FlowVersion): Promise<FlowVersion> => {
        if (flowVersion.state !== FlowVersionState.LOCKED) {
            return {
                ...flowVersion,
                schemaVersion: '13',
            }
        }

        const flow = await flowService(system.globalLogger()).getOneById(flowVersion.flowId)
        if (isNil(flow)) {
            return {
                ...flowVersion,
                schemaVersion: '13',
            }
        }
        const platformId = await projectService(system.globalLogger()).getPlatformId(flow.projectId)
        // A `Map`, not a `Record`: `transferFlow` below calls its callback for EVERY step, not only
        // the rewritten ones, and a step name is only checked against `STEP_NAME_REGEX`
        // (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`), which admits `constructor`, `toString`, `hasOwnProperty`,
        // `__proto__` — names that survive `ap_import_flow` verbatim. A bare `Record` index on one
        // of those reaches `Object.prototype` and would hand back a function (or, for `__proto__`,
        // an object) as the "piece version" — a bare `Record` index was also read with a truthiness
        // check rather than `isNil`, which would have let a truthy function through the same way.
        // Same idiom as the `hasOwn`, not a bare index guard in `ap-validate-flow.ts`'s delay-unit
        // lookup.
        const stepNameToPieceVersion = new Map<string, string>()
        const steps = flowStructureUtil.getAllSteps(flowVersion.trigger)
        for (const step of steps) {
            if (step.type === FlowActionType.PIECE || step.type === FlowTriggerType.PIECE) {
                const { data: qadamMetadata } = await tryCatch(async () => qadamMetadataService(system.globalLogger()).getOrThrow({
                    platformId,
                    name: step.settings.qadamName,
                    version: step.settings.qadamVersion,
                }),
                )
                if (!isNil(qadamMetadata)) {
                    stepNameToPieceVersion.set(step.name, qadamMetadata.version)
                }
            }
        }
        const newFlowVersion = flowStructureUtil.transferFlow(flowVersion, (step) => {
            const pieceVersion = stepNameToPieceVersion.get(step.name)
            if (!isNil(pieceVersion)) {
                return {
                    ...step,
                    settings: {
                        ...step.settings,
                        qadamVersion: pieceVersion,
                    },
                }
            }
            return step
        })
        return {
            ...newFlowVersion,
            schemaVersion: '13',
        }
    },
}

