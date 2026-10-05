import { isNil, LockResourceRequest, PrincipalType, WebsocketClientEvent, WebsocketServerEvent } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { userService } from '../../../user/user-service'
import { websocketService } from '../../websockets.service'
import { collaborativeResource } from '../collaborative-resource'
import { lockService } from './lock.service'

export const lockModule: FastifyPluginAsyncZod = async (app) => {
    websocketService.addListener({
        principalType: PrincipalType.USER,
        event: WebsocketServerEvent.LOCK_RESOURCE,
        handler: (socket) => {
            return async (data: LockResourceRequest, principal, projectId, callback) => {
                app.log.info({ resourceId: data.resourceId }, '[Lock] LOCK_RESOURCE event received')
                try {
                    // Locking is an edit action: a VIEWER must not be able to take a resource read-only
                    // for its editors. The required permission depends on the resource, so it is
                    // resolved (scoped by project) here rather than registered statically on the event.
                    const resource = await collaborativeResource.resolve({ resourceId: data.resourceId, projectId })
                    if (isNil(resource) || !websocketService.socketHasPermission({ socket, permission: resource.writePermission })) {
                        app.log.warn({ resourceId: data.resourceId, userId: principal.id, projectId }, '[LOCK_RESOURCE] Denied: missing write permission')
                        callback?.({ acquired: false, lock: null })
                        return
                    }

                    const user = await userService(app.log).getMetaInformation({ id: principal.id })
                    const displayName = `${user.firstName} ${user.lastName}`

                    const result = await lockService(app.log).acquire({
                        resourceId: data.resourceId,
                        userId: principal.id,
                        userDisplayName: displayName,
                        force: data.force,
                    })

                    if (result.acquired) {
                        if (!data.force) {
                            socket.data.lockedResourceId = data.resourceId
                        }
                        socket.to(projectId).emit(WebsocketClientEvent.RESOURCE_LOCKED, {
                            resourceId: data.resourceId,
                            userId: principal.id,
                            userDisplayName: displayName,
                        })
                    }

                    registerLockDisconnectHandler({ socket, userId: principal.id, projectId, app })

                    callback?.(result)
                }
                catch (error) {
                    app.log.error({ err: error }, '[LOCK_RESOURCE] Failed to acquire lock')
                    callback?.({ acquired: false, lock: null })
                }
            }
        },
    })
    websocketService.addListener({
        principalType: PrincipalType.USER,
        event: WebsocketServerEvent.UNLOCK_RESOURCE,
        handler: (socket) => {
            return async (data: { resourceId: string }, principal, projectId) => {
                try {
                    // Scope the id to this project like LOCK does: otherwise an id from another
                    // project would be echoed into this project's room, and an unrelated unlock
                    // would clear this socket's disconnect tracking.
                    const resource = await collaborativeResource.resolve({ resourceId: data.resourceId, projectId })
                    if (isNil(resource)) {
                        app.log.warn({ resourceId: data.resourceId, userId: principal.id, projectId }, '[UNLOCK_RESOURCE] Denied: resource does not belong to this project')
                        return
                    }
                    const released = await lockService(app.log).release({
                        resourceId: data.resourceId,
                        userId: principal.id,
                    })
                    if (released) {
                        socket.data.lockedResourceId = null
                        websocketService.to(projectId).emit(WebsocketClientEvent.RESOURCE_UNLOCKED, {
                            resourceId: data.resourceId,
                        })
                    }
                }
                catch (error) {
                    app.log.error({ err: error }, '[UNLOCK_RESOURCE] Failed to release lock')
                }
            }
        },
    })
}

function registerLockDisconnectHandler({ socket, userId, projectId, app }: RegisterDisconnectHandlerParams): void {
    if (socket.data.lockDisconnectRegistered) {
        return
    }
    socket.data.lockDisconnectRegistered = true
    socket.once('disconnect', async () => {
        const lockedResourceId = socket.data.lockedResourceId
        if (typeof lockedResourceId === 'string') {
            const released = await lockService(app.log).release({
                resourceId: lockedResourceId,
                userId,
            })
            if (released) {
                websocketService.to(projectId).emit(WebsocketClientEvent.RESOURCE_UNLOCKED, {
                    resourceId: lockedResourceId,
                })
            }
        }
    })
}

type RegisterDisconnectHandlerParams = {
    socket: { data: Record<string, unknown>, once: (event: string, handler: () => void) => void, id: string }
    userId: string
    projectId: string
    app: FastifyInstance
}
