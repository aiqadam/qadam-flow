import { ConnectionOption, isNil } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { appConnectionService } from '../app-connection/app-connection-service/app-connection-service'
import { mcpUtils } from '../mcp/tools/mcp-utils'
import { projectService } from '../project/project-service'
import { chatConversationService } from './chat-conversation.service'

export const chatConnections = {
    // Feeds the connection picker in the chat composer. Scoped to the one project the conversation
    // is bound to — the response carries a projectId per row, so a wider query here would hand the
    // browser connection identifiers from projects this conversation never touches.
    async list({ id, platformId, userId, qadamName, log }: ListParams): Promise<ConnectionOption[]> {
        const conversation = await chatConversationService.getOneOrThrow({ id, platformId, userId })
        if (isNil(conversation.projectId)) {
            return []
        }
        const project = await projectService(log).getOneOrThrow(conversation.projectId)
        // Belt and braces against a row whose project was moved between platforms: the picker must
        // never reach across a platform boundary even if the pinned id says otherwise.
        if (project.platformId !== platformId) {
            return []
        }

        const connections = await appConnectionService(log).list({
            projectId: project.id,
            platformId,
            cursorRequest: null,
            scope: undefined,
            displayName: undefined,
            status: undefined,
            qadamName: mcpUtils.normalizeQadamName(qadamName),
            limit: MAX_PICKER_CONNECTIONS,
            externalIds: undefined,
        })

        return connections.data.map((connection) => ({
            externalId: connection.externalId,
            label: connection.displayName,
            projectId: project.id,
            project: project.displayName,
            status: connection.status,
        }))
    },
}

const MAX_PICKER_CONNECTIONS = 200

type ListParams = {
    id: string
    platformId: string
    userId: string
    qadamName: string
    log: FastifyBaseLogger
}
