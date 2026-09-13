import {
    EngineResponseStatus,
    FlowTriggerType,
    FlowVersionState,
    TriggerHookType,
    WorkerJobType,
} from '@aiqadam/shared'
import type { ExecuteTriggerHookJobData, FlowVersion } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetVersion = vi.fn()

vi.mock('../../../../src/lib/cache/flow/flow-cache', () => ({
    flowCache: () => ({
        getVersion: mockGetVersion,
    }),
}))

vi.mock('../../../../src/lib/config/worker-settings', () => ({
    workerSettings: {
        getSettings: vi.fn().mockReturnValue({ TRIGGER_HOOKS_TIMEOUT_SECONDS: 60 }),
    },
}))

vi.mock('../../../../src/lib/execute/utils/flow-helpers', () => ({
    provisionFlowPieces: vi.fn(),
}))

import { executeTriggerHookJob } from '../../../../src/lib/execute/jobs/execute-trigger-hook'
import type { JobContext } from '../../../../src/lib/execute/types'
import { provisionFlowPieces } from '../../../../src/lib/execute/utils/flow-helpers'

const mockProvisionFlowPieces = vi.mocked(provisionFlowPieces)

function makeFlowVersion(): FlowVersion {
    return {
        id: 'fv-1',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
        flowId: 'flow-1',
        displayName: 'Test Flow',
        trigger: {
            name: 'trigger',
            valid: true,
            displayName: 'Tables Trigger',
            lastUpdatedDate: '2024-01-01T00:00:00Z',
            type: FlowTriggerType.PIECE,
            settings: {
                qadamName: '@aiqadam/qadam-tables',
                qadamVersion: '0.3.1',
                triggerName: 'new_record',
                input: {},
                propertySettings: {},
            },
        },
        updatedBy: null,
        valid: true,
        schemaVersion: null,
        agentIds: [],
        state: FlowVersionState.LOCKED,
        connectionIds: [],
        backupFiles: null,
        notes: [],
    }
}

function makeContext(): JobContext {
    return {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        apiClient: {},
        sandboxManager: {
            acquire: vi.fn(() => {
                throw new Error('the sandbox must not be reached when provisioning failed')
            }),
        },
        publicApiUrl: 'http://127.0.0.1:4200/api/',
        internalApiUrl: 'http://127.0.0.1:3000/',
        engineToken: 'engineToken',
        jobId: 'job-1',
    } as unknown as JobContext
}

function makeJobData(hookType: TriggerHookType): ExecuteTriggerHookJobData {
    return {
        jobType: WorkerJobType.EXECUTE_TRIGGER_HOOK,
        hookType,
        flowId: 'flow-1',
        flowVersionId: 'fv-1',
        projectId: 'project-1',
        platformId: 'platform-1',
        test: false,
    } as ExecuteTriggerHookJobData
}

// #432: returning OK here let `assertEngineResponseIsOk` pass, so enabling or publishing a flow
// whose pin is gone succeeded and produced a flow that reads ENABLED, registers no webhook and
// polls nothing — the same invisibility the removed auto-disable was supposed to stop causing.
describe('executeTriggerHookJob — unavailable pinned qadam', () => {
    beforeEach(() => {
        mockGetVersion.mockReset()
        mockProvisionFlowPieces.mockReset()
        mockGetVersion.mockResolvedValue(makeFlowVersion())
        mockProvisionFlowPieces.mockResolvedValue({ provisioned: false, unavailableQadam: '@aiqadam/qadam-tables@0.3.1' })
    })

    it('fails ON_ENABLE and names the pin', async () => {
        const result = await executeTriggerHookJob.execute(makeContext(), makeJobData(TriggerHookType.ON_ENABLE))

        expect(result.status).toBe(EngineResponseStatus.INTERNAL_ERROR)
        expect(result.errorMessage).toContain('@aiqadam/qadam-tables@0.3.1')
    })

    it('fails RENEW as well', async () => {
        const result = await executeTriggerHookJob.execute(makeContext(), makeJobData(TriggerHookType.RENEW))

        expect(result.status).toBe(EngineResponseStatus.INTERNAL_ERROR)
    })

    // Refusing ON_DISABLE would make a flow with a dead pin impossible to turn off.
    it('still reports ON_DISABLE as OK', async () => {
        const result = await executeTriggerHookJob.execute(makeContext(), makeJobData(TriggerHookType.ON_DISABLE))

        expect(result.status).toBe(EngineResponseStatus.OK)
        expect(result.errorMessage).toBeUndefined()
    })
})
