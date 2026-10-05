import { ErrorCode, isNil, Permission, Principal, PrincipalForType, PrincipalType, ProjectId, QadamFlowError, tryCatch, WebsocketServerEvent } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { Socket } from 'socket.io'
import { accessTokenManager } from '../authentication/lib/access-token-manager'
import { rejectedPromiseHandler } from '../helper/promise-handler'
import { canAccessProjectPermission, projectService, UserProjectAccess } from '../project/project-service'
import { app } from '../server'

export type WebsocketListener<T, PR extends PrincipalType.USER | PrincipalType.WORKER> = (socket: Socket) => (data: T, principal: PrincipalForType<PR>, projectId: PR extends PrincipalType.USER ? string : null, callback?: (data: unknown) => void) => Promise<void>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenerMap<PR extends PrincipalType.USER | PrincipalType.WORKER> = Partial<Record<WebsocketServerEvent, WebsocketListener<any, PR>>>

const listener = {
    [PrincipalType.USER]: {} as ListenerMap<PrincipalType.USER>,
    [PrincipalType.WORKER]: {} as ListenerMap<PrincipalType.WORKER>,
}

// The project access most recently resolved for a socket, refreshed on every USER event (and at
// join), so `socketHasPermission` inside a listener reads a current grant. `eventPermissions` maps
// a `principalType:event` pair to the permission its HTTP equivalent requires; a VIEWER — who can
// now join the project room — must not be able to emit a write event such as
// MANUAL_TRIGGER_RUN_STARTED.
const projectAccessBySocket = new WeakMap<Socket, UserProjectAccess>()
const eventPermissions = new Map<string, Permission>()

export const websocketService = {
    to: (workerId: string) => app!.io.to(workerId),
    async init(socket: Socket, log: FastifyBaseLogger): Promise<void> {
        const principal = await websocketService.verifyPrincipal(socket)
        const type = principal.type
        if (![PrincipalType.USER, PrincipalType.WORKER].includes(type)) {
            return
        }

        const castedType = type as keyof typeof listener
        const projectId = socket.handshake.auth.projectId
        switch (type) {
            case PrincipalType.USER: {
                // Join the user room before the project check: server-emitted user-scoped events
                // (chat chunks, badges) still reach the socket when the project handshake is
                // rejected. A rejected socket gets no project room and no client-to-server
                // listeners, so it can still receive but cannot act on the project.
                await socket.join(principal.id)
                const access = await validateProjectId({ userId: principal.id, projectId })
                projectAccessBySocket.set(socket, access)
                log.info({
                    message: 'User connected',
                    userId: principal.id,
                    projectId,
                })
                await socket.join(projectId)
                break
            }
            case PrincipalType.WORKER: {
                const workerId = socket.handshake.auth.workerId
                log.info({
                    message: 'Worker connected',
                    workerId,
                })
                await socket.join(workerId)
                break
            }
            default: {
                throw new QadamFlowError({
                    code: ErrorCode.AUTHENTICATION,
                    params: {
                        message: 'Invalid principal type',
                    },
                })
            }
        }
        for (const [event, handler] of Object.entries(listener[castedType])) {
            socket.on(event, async (data, callback) => {
                if (castedType === PrincipalType.USER) {
                    // Re-resolve on every client-to-server event instead of trusting the grant cached
                    // at join, so a member removed or demoted after connecting is blocked from sending
                    // immediately, as they would be over HTTP. Server-pushed broadcasts are stopped
                    // separately, by eviction on the membership-change paths.
                    const resolution = await resolveAccessOrDeny({ socket, userId: principal.id, projectId, event, log })
                    if (resolution.outcome !== 'granted') {
                        // Only an explicit authorization denial evicts from the room; a transient
                        // failure must not permanently drop a still-authorized socket from project
                        // broadcasts for the rest of its session.
                        if (resolution.outcome === 'denied') {
                            await socket.leave(projectId)
                        }
                        callback?.({ error: ErrorCode.AUTHORIZATION, message: 'Access to this project is no longer granted' })
                        return
                    }
                    const requiredPermission = eventPermissions.get(permissionKey({ principalType: castedType, event }))
                    if (!isNil(requiredPermission) && !canAccessProjectPermission({ access: resolution.access, permission: requiredPermission })) {
                        log.warn({ event, userId: principal.id, projectId, requiredPermission }, 'Websocket event blocked: missing permission')
                        callback?.({ error: ErrorCode.PERMISSION_DENIED, message: 'Missing permission for this event' })
                        return
                    }
                }
                return rejectedPromiseHandler(handler(socket)(data, principal, projectId, callback), log)
            })
        }
        for (const handler of Object.values(listener[castedType][WebsocketServerEvent.CONNECT] ?? {})) {
            handler(socket)
        }
    },
    async onDisconnect(socket: Socket): Promise<void> {
        const principal = await websocketService.verifyPrincipal(socket)
        const castedType = principal.type as keyof typeof listener
        for (const handler of Object.values(listener[castedType][WebsocketServerEvent.DISCONNECT] ?? {})) {
            handler(socket)
        }
    },
    async verifyPrincipal(socket: Socket): Promise<Principal> {
        return accessTokenManager(app!.log).verifyPrincipal(socket.handshake.auth.token)
    },
    addListener<T, PR extends PrincipalType.WORKER | PrincipalType.USER>({ principalType, event, handler, permission }: AddListenerParams<T, PR>): void {
        switch (principalType) {
            case PrincipalType.USER: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                listener[PrincipalType.USER][event] = handler as unknown as WebsocketListener<any, PrincipalType.USER>
                const key = permissionKey({ principalType, event })
                if (isNil(permission)) {
                    eventPermissions.delete(key)
                }
                else {
                    eventPermissions.set(key, permission)
                }
                break
            }
            case PrincipalType.WORKER: {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                listener[PrincipalType.WORKER][event] = handler as unknown as WebsocketListener<any, PrincipalType.WORKER>
                break
            }
        }
    },
    // For listeners whose required permission depends on the resource (e.g. a lock on a flow needs
    // WRITE_FLOW while a lock on a table needs WRITE_TABLE), so they can check inside the handler.
    socketHasPermission: ({ socket, permission }: SocketHasPermissionParams): boolean => {
        return socketAllowsPermission({ access: projectAccessBySocket.get(socket), permission })
    },
    // Called from membership-change paths (platform user removal/role change, LDAP group-mapping
    // removal) so a revoked user stops receiving project broadcasts immediately, not only on their
    // next event. `socketsLeave` is adapter-aware: behind the Redis adapter it publishes a
    // REMOTE_LEAVE that evicts the user's sockets from the room on every API node.
    evictUserFromProjects: ({ userId, projectIds }: EvictUserFromProjectsParams): void => {
        if (isNil(app)) {
            return
        }
        for (const projectId of projectIds) {
            app.io.in(userId).socketsLeave(projectId)
        }
    },
    emitWithAck<T = unknown>(event: WebsocketServerEvent, workerId: string, data?: unknown): Promise<T> {
        return app!.io.to([workerId]).timeout(4000).emitWithAck(event, data)
    },
}

function socketAllowsPermission({ access, permission }: SocketAllowsPermissionParams): boolean {
    if (isNil(access)) {
        return false
    }
    return canAccessProjectPermission({ access, permission })
}

// Keyed by principal type as well as event, so a USER permission can never leak onto a WORKER
// listener that happens to share the event name.
function permissionKey({ principalType, event }: PermissionKeyParams): string {
    return `${principalType}:${event}`
}

async function resolveAccessOrDeny({ socket, userId, projectId, event, log }: ResolveAccessOrDenyParams): Promise<AccessResolution> {
    const result = await tryCatch(() => projectService(app!.log).resolveUserProjectAccessOrThrow({ userId, projectId }))
    if (result.error === null) {
        projectAccessBySocket.set(socket, result.data)
        return { outcome: 'granted', access: result.data }
    }
    // Distinguish a real revocation from an infrastructure failure: only the former should drop the
    // socket from the project room.
    const denied = result.error instanceof QadamFlowError
        && (result.error.error.code === ErrorCode.AUTHORIZATION || result.error.error.code === ErrorCode.ENTITY_NOT_FOUND)
    log.warn({ err: result.error, event, userId, projectId, denied }, 'Websocket event blocked: project access could not be verified')
    return { outcome: denied ? 'denied' : 'error' }
}

const validateProjectId = async ({ userId, projectId }: ValidateProjectIdArgs): Promise<UserProjectAccess> => {
    if (isNil(projectId)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHENTICATION,
            params: {
                message: 'Project ID is required',
            },
        })
    }
    return projectService(app!.log).resolveUserProjectAccessOrThrow({ userId, projectId })
}

type ValidateProjectIdArgs = {
    userId: string
    projectId?: string
}

type SocketHasPermissionParams = {
    socket: Socket
    permission: Permission
}

type SocketAllowsPermissionParams = {
    access: UserProjectAccess | undefined
    permission: Permission
}

type AddListenerParams<T, PR extends PrincipalType.WORKER | PrincipalType.USER> = {
    principalType: PR
    event: WebsocketServerEvent
    handler: WebsocketListener<T, PR>
    permission?: Permission
}

type ResolveAccessOrDenyParams = {
    socket: Socket
    userId: string
    projectId: ProjectId
    event: string
    log: FastifyBaseLogger
}

type PermissionKeyParams = {
    principalType: PrincipalType.USER | PrincipalType.WORKER
    event: string
}

type EvictUserFromProjectsParams = {
    userId: string
    projectIds: string[]
}

type AccessResolution =
    | { outcome: 'granted', access: UserProjectAccess }
    | { outcome: 'denied' }
    | { outcome: 'error' }