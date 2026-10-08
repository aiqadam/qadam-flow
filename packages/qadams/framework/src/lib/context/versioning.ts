import { PauseType } from '@aiqadam/shared';
import { ActionContext, PauseHook } from ".";
import { InputPropertyMap, QadamAuthProperty } from "../property";

export enum ContextVersion {
    V1 = '1',
    V2 = '2',
}
// When introducing a new context version, bump BOTH constants together.
// The floor is load-bearing: older engines bundle an older framework whose
// switch below only knows the older ContextVersion cases. A piece compiled
// against a newer framework reports the new version via getContextInfo(),
// the switch falls through, returns undefined, and the engine then invokes
// run(undefined) — surfacing as "Cannot read properties of undefined".
// Enforcing the floor in piece.ts keeps such pieces out of the registry on
// incompatible servers instead of crashing at execution time.
// A new context version is also a new framework major with its own row in
// framework-support-table.json beside this file (ADR-0002); gate 8,
// tools/ci/check-framework-support.mjs, fails the build until both are in.
export const LATEST_CONTEXT_VERSION = ContextVersion.V2;
export const MINIMUM_SUPPORTED_RELEASE_AFTER_LATEST_CONTEXT_VERSION = '0.82.0';

export const backwardCompatabilityContextUtils = {
    makeActionContextBackwardCompatible({ context, contextVersion }: MakeActionContextBackwardCompatibleParams): ActionContext<QadamAuthProperty, InputPropertyMap> {
        switch (contextVersion) {
            case ContextVersion.V2:
                return context;
            case ContextVersion.V1:
                return addLegacyMethods({ context });
            case undefined:
                return addLegacyMethodsAndServerUrl({ context });
        }
    },
}

function addLegacyMethods({ context }: { context: ActionContext<QadamAuthProperty, InputPropertyMap> }): ActionContext<QadamAuthProperty, InputPropertyMap> {
    return {
        ...context,
        generateResumeUrl: buildLegacyGenerateResumeUrl({ context }),
        run: {
            ...context.run,
            pause: buildLegacyPauseHook({ context }),
        },
    }
}

function addLegacyMethodsAndServerUrl({ context }: { context: ActionContext<QadamAuthProperty, InputPropertyMap> }): ActionContext<QadamAuthProperty, InputPropertyMap> {
    return {
        ...addLegacyMethods({ context }),
        serverUrl: context.server.publicUrl,
    } as unknown as ActionContext<QadamAuthProperty, InputPropertyMap>
}

/**
 * @deprecated Since 2026-04-12. Kept under ADR-0002 (`adr/0002-two-framework-majors-supported-for-at-least-12-months.md`): this shim serves the `0.x` row of the framework support table and may be removed no earlier than 12 months after `@aiqadam/qadams-framework@1.0.0`, and only once the support-table gate allows it. Qadams use `createWaitpoint`/`waitForWaitpoint` instead.
 */
function buildLegacyPauseHook({ context }: { context: ActionContext<QadamAuthProperty, InputPropertyMap> }): PauseHook {
    return (req) => {
        const type = req.pauseMetadata.type === PauseType.DELAY ? 'DELAY' as const : 'WEBHOOK' as const
        const responseToSend = req.pauseMetadata.type === PauseType.WEBHOOK ? req.pauseMetadata.response : undefined
        const resumeDateTime = req.pauseMetadata.type === PauseType.DELAY ? req.pauseMetadata.resumeDateTime : undefined
        context.run.createWaitpoint({ type, version: 'V0', resumeDateTime, responseToSend }).catch((e) => {
            console.error('[buildLegacyPauseHook] Failed to create waitpoint', e)
            process.exit(1)
        })
        context.run.waitForWaitpoint('')
    }
}

/**
 * @deprecated Since 2026-04-12. Kept under ADR-0002 (`adr/0002-two-framework-majors-supported-for-at-least-12-months.md`): this shim serves the `0.x` row of the framework support table and may be removed no earlier than 12 months after `@aiqadam/qadams-framework@1.0.0`, and only once the support-table gate allows it. Qadams use `createWaitpoint`/`waitForWaitpoint` instead.
 */
function buildLegacyGenerateResumeUrl({ context }: { context: ActionContext<QadamAuthProperty, InputPropertyMap> }): (params: { queryParams: Record<string, string>, sync?: boolean }) => string {
    return (params) => {
        const randomId = Math.random().toString(36).substring(2)
        const url = new URL(`${context.server.publicUrl}v1/flow-runs/${context.run.id}/requests/${randomId}${params.sync ? '/sync' : ''}`)
        url.search = new URLSearchParams(params.queryParams).toString()
        return url.toString()
    }
}

type MakeActionContextBackwardCompatibleParams = {
    context: ActionContext<QadamAuthProperty, InputPropertyMap>;
    contextVersion: ContextVersion | undefined;
}
