import { apId, FlowVersion, FlowVersionId, FlowVersionState, ProjectId } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { EntityManager } from 'typeorm'
import { flowRepo } from '../../flows/flow/flow.repo'
import { FlowVersionSchema } from '../../flows/flow-version/flow-version-entity'
import { flowVersionRepo } from '../../flows/flow-version/flow-version.service'

// Where a pin move or its revert writes a rewritten trigger. A worker caches a LOCKED version by its
// id and re-reads it only when its schema version changes, so a published version rewritten in place
// would keep running its old pins on every worker that already ran it, and its trigger source would
// stay registered with them. The published version is therefore never rewritten: a new LOCKED version
// with the rewritten content takes its place, the way a publish does (a new row, then
// `publishedVersionId`), in the caller's transaction. A draft is rewritten in place, and so is a
// locked version that is not the published one: nothing runs it.
export const qadamPinVersionWriter = {
    write: async ({ manager, current, trigger, projectId, publishedVersionId }: WriteParams): Promise<WrittenVersion> => {
        if (current.state !== FlowVersionState.LOCKED || current.id !== publishedVersionId) {
            await flowVersionRepo(manager).update({ id: current.id }, { trigger })
            return { flowVersion: await flowVersionRepo(manager).findOneByOrFail({ id: current.id }), replacedPublished: false }
        }
        const { flow: _flow, updatedByUser: _updatedByUser, ...fields } = current
        const id = apId()
        // One millisecond after the version it replaces, so it stays the flow's latest version unless a
        // draft is newer, as that version was.
        await flowVersionRepo(manager).insert({
            ...fields,
            id,
            created: dayjs(current.created).add(1, 'millisecond').toISOString(),
            updated: dayjs().toISOString(),
            trigger,
        })
        const created = await flowVersionRepo(manager).findOneByOrFail({ id })
        await flowRepo(manager).update({ id: current.flowId, projectId }, { publishedVersionId: created.id })
        return { flowVersion: created, replacedPublished: true }
    },
}

type WriteParams = {
    manager: EntityManager
    current: FlowVersionSchema
    trigger: FlowVersion['trigger']
    projectId: ProjectId
    // The flow's published version, read in the same transaction.
    publishedVersionId: FlowVersionId | null
}

export type WrittenVersion = {
    flowVersion: FlowVersion
    // True when a new locked version took the place of the published one.
    replacedPublished: boolean
}
