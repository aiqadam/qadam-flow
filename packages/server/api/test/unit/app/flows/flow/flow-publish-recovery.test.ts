import { FlowStatus } from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEnable = vi.fn()
const mockDisable = vi.fn()
const mockGetFlowVersionOrThrow = vi.fn()
const mockInvalidate = vi.fn()
const mockUpdate = vi.fn()

vi.mock('../../../../../src/app/trigger/trigger-source/trigger-source-service', () => ({
    triggerSourceService: () => ({
        enable: mockEnable,
        disable: mockDisable,
    }),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionService: () => ({
        getFlowVersionOrThrow: mockGetFlowVersionOrThrow,
    }),
}))

vi.mock('../../../../../src/app/flows/flow/flow-execution-cache', () => ({
    flowExecutionCache: () => ({
        invalidate: mockInvalidate,
    }),
}))

vi.mock('../../../../../src/app/flows/flow/flow.repo', () => ({
    flowRepo: () => ({
        update: mockUpdate,
    }),
}))

import { restoreFlowAfterFailedPublish } from '../../../../../src/app/flows/flow/flow-publish-recovery'

const FLOW_ID = 'flow-1'
const PROJECT_ID = 'project-1'
const PREVIOUS_VERSION_ID = 'fv-previous'

const mockLog = pino({ level: 'silent' })
const errorSpy = vi.spyOn(mockLog, 'error')
const warnSpy = vi.spyOn(mockLog, 'warn')

const previousVersion = { id: PREVIOUS_VERSION_ID, flowId: FLOW_ID }

const disableCall = {
    flowId: FLOW_ID,
    projectId: PROJECT_ID,
    simulate: false,
    ignoreError: true,
}

function restore(params: { previousStatus: FlowStatus, previousPublishedVersionId: string | null }) {
    return restoreFlowAfterFailedPublish({
        flowId: FLOW_ID,
        projectId: PROJECT_ID,
        previousStatus: params.previousStatus,
        previousPublishedVersionId: params.previousPublishedVersionId,
        log: mockLog,
    })
}

describe('restoreFlowAfterFailedPublish', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetFlowVersionOrThrow.mockResolvedValue(previousVersion)
        mockEnable.mockResolvedValue(undefined)
        mockDisable.mockResolvedValue(undefined)
        mockUpdate.mockResolvedValue(undefined)
        mockInvalidate.mockResolvedValue(undefined)
    })

    it('re-enables the previous version and restores an enabled flow', async () => {
        await restore({ previousStatus: FlowStatus.ENABLED, previousPublishedVersionId: PREVIOUS_VERSION_ID })

        expect(mockGetFlowVersionOrThrow).toHaveBeenCalledWith({
            flowId: FLOW_ID,
            versionId: PREVIOUS_VERSION_ID,
            projectId: PROJECT_ID,
        })
        expect(mockEnable).toHaveBeenCalledWith({ flowVersion: previousVersion, projectId: PROJECT_ID, simulate: false })
        expect(mockDisable).not.toHaveBeenCalled()
        expect(mockUpdate).toHaveBeenCalledWith({ id: FLOW_ID, projectId: PROJECT_ID }, {
            status: FlowStatus.ENABLED,
            publishedVersionId: PREVIOUS_VERSION_ID,
        })
        expect(mockInvalidate).toHaveBeenCalledWith(FLOW_ID)
    })

    it('leaves the flow DISABLED and cleans up when it was enabled but has no previous published version to re-register', async () => {
        await restore({ previousStatus: FlowStatus.ENABLED, previousPublishedVersionId: null })

        expect(mockEnable).not.toHaveBeenCalled()
        expect(mockDisable).toHaveBeenCalledWith(disableCall)
        expect(warnSpy).toHaveBeenCalled()
        expect(mockUpdate).toHaveBeenCalledWith({ id: FLOW_ID, projectId: PROJECT_ID }, {
            status: FlowStatus.DISABLED,
            publishedVersionId: null,
        })
    })

    it('removes any trigger source a failed enable left behind for a flow that was disabled', async () => {
        await restore({ previousStatus: FlowStatus.DISABLED, previousPublishedVersionId: null })

        expect(mockEnable).not.toHaveBeenCalled()
        expect(mockDisable).toHaveBeenCalledWith(disableCall)
        expect(mockUpdate).toHaveBeenCalledWith({ id: FLOW_ID, projectId: PROJECT_ID }, {
            status: FlowStatus.DISABLED,
            publishedVersionId: null,
        })
    })

    it('leaves the flow DISABLED and cleans up when the previous trigger cannot be re-enabled', async () => {
        mockEnable.mockRejectedValue(new Error('still down'))

        await expect(restore({ previousStatus: FlowStatus.ENABLED, previousPublishedVersionId: PREVIOUS_VERSION_ID }))
            .resolves.toBeUndefined()

        expect(mockDisable).toHaveBeenCalledWith(disableCall)
        expect(mockUpdate).toHaveBeenCalledWith({ id: FLOW_ID, projectId: PROJECT_ID }, {
            status: FlowStatus.DISABLED,
            publishedVersionId: PREVIOUS_VERSION_ID,
        })
        expect(errorSpy).toHaveBeenCalled()
    })

    it('leaves the flow DISABLED and cleans up when the previous version cannot be loaded', async () => {
        mockGetFlowVersionOrThrow.mockRejectedValue(new Error('version is gone'))

        await expect(restore({ previousStatus: FlowStatus.ENABLED, previousPublishedVersionId: PREVIOUS_VERSION_ID }))
            .resolves.toBeUndefined()

        expect(mockEnable).not.toHaveBeenCalled()
        expect(mockDisable).toHaveBeenCalledWith(disableCall)
        expect(mockUpdate).toHaveBeenCalledWith({ id: FLOW_ID, projectId: PROJECT_ID }, {
            status: FlowStatus.DISABLED,
            publishedVersionId: PREVIOUS_VERSION_ID,
        })
        expect(errorSpy).toHaveBeenCalled()
    })

    it('does not throw when the row update itself fails', async () => {
        mockUpdate.mockRejectedValue(new Error('database is down'))

        await expect(restore({ previousStatus: FlowStatus.DISABLED, previousPublishedVersionId: null }))
            .resolves.toBeUndefined()

        expect(errorSpy).toHaveBeenCalled()
    })
})
