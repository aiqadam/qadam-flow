import { websocketService } from '../../core/websockets.service'

export const projectMemberSideEffects = {
    // The membership row is gone, but the removed user's sockets still hold the project room and
    // its cached access. Called after the removal transaction commits so broadcasts stop now rather
    // than at the removed user's next event.
    evictRemovedMember({ userId, projectId }: EvictRemovedMemberParams): void {
        websocketService.evictUserFromProjects({ userId, projectIds: [projectId] })
    },
}

type EvictRemovedMemberParams = {
    userId: string
    projectId: string
}
