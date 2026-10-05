import { isNil, Permission } from '@aiqadam/shared'
import { FlowEntity } from '../../flows/flow/flow.entity'
import { TableEntity } from '../../tables/table/table.entity'
import { repoFactory } from '../db/repo-factory'

const flowRepo = repoFactory(FlowEntity)
const tableRepo = repoFactory(TableEntity)

// The resources the collaborative features (presence, locks) attach to. Resolving the resource by
// `projectId` is what stops a member of one project from reading another project's presence or
// taking its locks with a resource id they guessed: the lookup is scoped, so a foreign id resolves
// to `null` and the caller denies.
export const collaborativeResource = {
    async resolve({ resourceId, projectId }: ResolveParams): Promise<CollaborativeResource | null> {
        const flow = await flowRepo().findOneBy({ id: resourceId, projectId })
        if (!isNil(flow)) {
            return { writePermission: Permission.WRITE_FLOW }
        }
        const table = await tableRepo().findOneBy({ id: resourceId, projectId })
        if (!isNil(table)) {
            return { writePermission: Permission.WRITE_TABLE }
        }
        return null
    },
}

type ResolveParams = {
    resourceId: string
    projectId: string
}

export type CollaborativeResource = {
    writePermission: Permission
}
