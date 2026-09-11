import { FlowStatus } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { longPollingTransportChange } from '../../../../../src/app/trigger/long-polling/long-polling-transport-change'

const QADAM_NAME = '@aiqadam/qadam-telegram-bot'

const triggerSourceFind = vi.fn()
const flowVersionFind = vi.fn()
const enableTrigger = vi.fn()
const getFlowVersion = vi.fn()

vi.mock('../../../../../src/app/core/db/repo-factory', () => ({
    repoFactory: (entity: { options: { name: string } }) => () => (
        entity.options.name === 'flow_version' ? { find: flowVersionFind } : { find: triggerSourceFind }
    ),
}))

vi.mock('../../../../../src/app/flows/flow-version/flow-version.service', () => ({
    flowVersionService: () => ({ getOneOrThrow: getFlowVersion }),
}))

vi.mock('../../../../../src/app/trigger/trigger-source/trigger-source-service', () => ({
    triggerSourceService: () => ({ enable: enableTrigger }),
}))

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger

function triggeredBy({ id, externalId }: { id: string, externalId: string }) {
    return { id, trigger: { settings: { input: { auth: `{{connections['${externalId}']}}` } } } }
}

const connection = {
    qadamName: QADAM_NAME,
    projectIds: ['project1'],
    externalId: 'telegram',
}

describe('longPollingTransportChange', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        triggerSourceFind.mockResolvedValue([{
            flowId: 'flow1',
            flowVersionId: 'fv1',
            projectId: 'project1',
            flow: { status: FlowStatus.ENABLED },
        }])
        flowVersionFind.mockResolvedValue([triggeredBy({ id: 'fv1', externalId: 'telegram' })])
        getFlowVersion.mockResolvedValue({ id: 'fv1', flowId: 'flow1' })
        enableTrigger.mockResolvedValue(undefined)
    })

    // The hook that registers or removes the webhook only runs on enable, so a mode change has to
    // re-run it — otherwise switching back to webhook leaves the flow receiving nothing at all.
    it('re-runs the trigger hook when the delivery mode changes', async () => {
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'long_polling' },
            after: { transport: 'webhook' },
        })

        expect(enableTrigger).toHaveBeenCalledTimes(1)
        expect(enableTrigger.mock.calls[0][0]).toMatchObject({ projectId: 'project1', simulate: false })
    })

    it('re-runs it in the other direction too', async () => {
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })

        expect(enableTrigger).toHaveBeenCalledTimes(1)
    })

    // Keyed on the puller's verdict, not on a key name: an unrelated metadata edit must not
    // re-enable every flow on the connection.
    it('does nothing when the mode did not change', async () => {
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook', label: 'before' },
            after: { transport: 'webhook', label: 'after' },
        })

        expect(enableTrigger).not.toHaveBeenCalled()
        expect(triggerSourceFind).not.toHaveBeenCalled()
    })

    it('ignores a qadam no puller backs', async () => {
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            qadamName: '@aiqadam/qadam-slack',
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })

        expect(enableTrigger).not.toHaveBeenCalled()
    })

    it('leaves alone a flow that does not use this connection', async () => {
        flowVersionFind.mockResolvedValue([triggeredBy({ id: 'fv1', externalId: 'some-other-connection' })])

        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })

        expect(enableTrigger).not.toHaveBeenCalled()
    })

    // `flowVersion.connectionIds` unions the trigger's auth with every action step's, so matching
    // on it re-enabled flows that merely *send* to Telegram — re-seeding the cursor of a Gmail
    // trigger and dropping every message since its last poll. Only the trigger's own auth counts.
    it('leaves alone a flow that uses this connection only in an action', async () => {
        flowVersionFind.mockResolvedValue([{
            ...triggeredBy({ id: 'fv1', externalId: 'gmail-connection' }),
            connectionIds: ['gmail-connection', 'telegram'],
        }])

        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })

        expect(enableTrigger).not.toHaveBeenCalled()
    })

    // The registry only ever pulls for one qadam's triggers, so the query must not drag in every
    // enabled flow in every project the connection is shared with just to filter them in memory.
    it('asks the database only for trigger sources of this qadam', async () => {
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })

        expect(triggerSourceFind.mock.calls[0][0].where).toMatchObject({ qadamName: QADAM_NAME })
    })

    // Dropping a concurrent change is only safe because the run already in flight re-reads live
    // state on entry — so it sees whatever the dropped change wanted. If it ever stops re-reading,
    // this stops being a coalesce and starts being a lost update.
    it('drops a change that arrives while one is already running, rather than queueing it', async () => {
        let releaseFirst = (): void => {}
        triggerSourceFind.mockImplementationOnce(async () => {
            await new Promise<void>((resolve) => {
                releaseFirst = resolve
            })
            return []
        })

        const first = longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'long_polling' },
            after: { transport: 'webhook' },
        })

        expect(triggerSourceFind).toHaveBeenCalledTimes(1)
        releaseFirst()
        await first

        // And the guard is released, so the next change is not swallowed too.
        await longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })
        expect(triggerSourceFind).toHaveBeenCalledTimes(2)
    })

    // The mode is already saved by the time this runs; one flow failing must not undo the user's
    // edit or stop the other flows from being re-enabled.
    it('keeps going when one flow fails, and does not throw', async () => {
        triggerSourceFind.mockResolvedValue([
            { flowId: 'flow1', flowVersionId: 'fv1', projectId: 'project1', flow: { status: FlowStatus.ENABLED } },
            { flowId: 'flow2', flowVersionId: 'fv2', projectId: 'project1', flow: { status: FlowStatus.ENABLED } },
        ])
        flowVersionFind.mockResolvedValue([
            triggeredBy({ id: 'fv1', externalId: 'telegram' }),
            triggeredBy({ id: 'fv2', externalId: 'telegram' }),
        ])
        enableTrigger.mockRejectedValueOnce(new Error('the third party refused'))

        await expect(longPollingTransportChange(mockLog).reEnableAffectedFlows({
            ...connection,
            before: { transport: 'webhook' },
            after: { transport: 'long_polling' },
        })).resolves.toBeUndefined()

        expect(enableTrigger).toHaveBeenCalledTimes(2)
        expect(mockLog.error).toHaveBeenCalled()
    })
})
