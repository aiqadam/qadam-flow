import {
    DefaultProjectRole,
    FlowStatus,
    FlowVersionState,
    LockResourceResponse,
    PlatformRole,
    PrincipalType,
    ProjectType,
    UserStatus,
    WebsocketClientEvent,
    WebsocketServerEvent,
} from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Socket as ClientSocket, io as ioClient } from 'socket.io-client'
import { generateMockToken } from '../../../helpers/auth'
import { db } from '../../../helpers/db'
import { createMockFlow, createMockFlowVersion, createMockProject, mockBasicUser } from '../../../helpers/mocks'
import { createMemberContext, createTestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

// The websocket join used to accept only `project.ownerId`, so every TEAM member and every
// platform admin who did not own the project connected to a dead socket (no room, no handlers) —
// "Test flow" hung in the builder. These tests pin the room membership of the socket after
// `websockets.service.ts:init`, for each bypass `authorize.ts:assertAccessToProject` recognizes.
//
// They go over a real socket because the join only happens on a live connection; `app.inject`
// never runs `app.io.on('connection')`. Room membership is read from the local namespace's socket
// map rather than trusting an emitted event, so a socket that connected but never joined fails the
// assertion.
// `init` joins the user room before the project check, so a rejected socket is observed there
// first; the project room then has to stay empty for this window to prove the rejection.
const REJECTION_WINDOW_MS = 3000
const MANUAL_TRIGGER_TIMEOUT_MS = 5000
// A denied permission produces no response, so the negative case must wait at least as long as the
// allowed path is allowed to take — the same bound, or a slow allowed path would read as denied.
const PERMISSION_DENIED_WINDOW_MS = MANUAL_TRIGGER_TIMEOUT_MS

let app: FastifyInstance
let apiUrl: string

beforeAll(async () => {
    app = await setupTestEnvironment()
    if (!app.server.listening) {
        await app.listen({ port: 0, host: '127.0.0.1' })
    }
    apiUrl = `http://127.0.0.1:${listeningPort(app)}`
})

afterAll(async () => {
    await teardownTestEnvironment()
})

function listeningPort(instance: FastifyInstance): number {
    const address = instance.server.address()
    if (address === null || typeof address === 'string') {
        throw new Error('test server is not listening on a TCP port')
    }
    return address.port
}

describe('websocket project authorization', () => {
    it('allows the owner of a PERSONAL project', async () => {
        const ctx = await createTestContext(app)
        const { mockUser: owner } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const personalProject = createMockProject({
            ownerId: owner.id,
            platformId: ctx.platform.id,
            type: ProjectType.PERSONAL,
        })
        await db.save('project', personalProject)
        const token = await generateMockToken({ id: owner.id, type: PrincipalType.USER, platform: { id: ctx.platform.id } })

        await expectAllowed({ token, userId: owner.id, projectId: personalProject.id })
    })

    it.each([DefaultProjectRole.EDITOR, DefaultProjectRole.VIEWER])(
        'allows a TEAM member with the %s role',
        async (projectRole) => {
            const ctx = await createTestContext(app)
            const memberCtx = await createMemberContext(app, ctx, { projectRole })

            await expectAllowed({ token: memberCtx.token, userId: memberCtx.user.id, projectId: ctx.project.id })
        },
    )

    it('allows a platform ADMIN who is not a member of the project', async () => {
        const ctx = await createTestContext(app)
        // A project owned by someone else on the same platform, so the only reason the admin is
        // admitted is the privileged-user bypass — not ownership.
        const { mockUser: otherUser } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const teamProject = createMockProject({
            ownerId: otherUser.id,
            platformId: ctx.platform.id,
            type: ProjectType.TEAM,
        })
        await db.save('project', teamProject)

        await expectAllowed({ token: ctx.token, userId: ctx.user.id, projectId: teamProject.id })
    })

    it('rejects a same-platform user who is not a member', async () => {
        const ctx = await createTestContext(app)
        const { mockUser: bystander } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const token = await generateMockToken({ id: bystander.id, type: PrincipalType.USER, platform: { id: ctx.platform.id } })

        await expectRejected({ token, userId: bystander.id, projectId: ctx.project.id })
    })

    it('rejects a user from another platform, even a platform admin', async () => {
        const ctx = await createTestContext(app)
        // A whole second platform: its owner is a platform ADMIN there, but has no business in
        // `ctx`'s platform — the platform check must come before the privilege bypass.
        const otherCtx = await createTestContext(app)

        await expectRejected({ token: otherCtx.token, userId: otherCtx.user.id, projectId: ctx.project.id })
    })

    it('always joins the user room, even when the project is rejected', async () => {
        const ctx = await createTestContext(app)
        const { mockUser: bystander } = await mockBasicUser({
            user: { platformId: ctx.platform.id, platformRole: PlatformRole.MEMBER },
        })
        const token = await generateMockToken({ id: bystander.id, type: PrincipalType.USER, platform: { id: ctx.platform.id } })

        const socket = await connectSocket({ token, projectId: ctx.project.id })
        try {
            expect(await waitFor({ predicate: () => isInRoom({ room: bystander.id, socketId: socket.id }) })).toBe(true)
        }
        finally {
            socket.disconnect()
        }
    })
})

// Widening the join to every member also exposes the write listeners. A VIEWER now reaches them,
// so the events whose HTTP equivalent needs a permission must enforce it per event.
describe('websocket per-event permissions', () => {
    it('lets an EDITOR start a manual run but blocks a VIEWER', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)

        const editorCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.EDITOR })
        const viewerCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.VIEWER })

        const editorStarted = await emitManualTrigger({ token: editorCtx.token, projectId: ctx.project.id, flowVersionId: flowVersion.id, timeoutMs: MANUAL_TRIGGER_TIMEOUT_MS })
        expect(editorStarted).toBe(true)

        const viewerStarted = await emitManualTrigger({ token: viewerCtx.token, projectId: ctx.project.id, flowVersionId: flowVersion.id, timeoutMs: PERMISSION_DENIED_WINDOW_MS })
        expect(viewerStarted).toBe(false)
    })

    it('lets an EDITOR lock a flow but denies a VIEWER', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED })
        await db.save('flow', flow)

        const editorCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.EDITOR })
        const viewerCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.VIEWER })

        const editorLock = await emitLock({ token: editorCtx.token, projectId: ctx.project.id, resourceId: flow.id })
        expect(editorLock.acquired).toBe(true)

        // `emitLock` disconnects the editor socket, which releases the lock, so a VIEWER without
        // the gate would acquire it (`acquired: true`) — `acquired: false, lock: null` proves the
        // permission check fired first.
        const viewerLock = await emitLock({ token: viewerCtx.token, projectId: ctx.project.id, resourceId: flow.id })
        expect(viewerLock).toEqual({ acquired: false, lock: null })
    })

    it('denies a lock for a resource that belongs to another project', async () => {
        const ctx = await createTestContext(app)
        const otherProject = createMockProject({ ownerId: ctx.user.id, platformId: ctx.platform.id, type: ProjectType.TEAM })
        await db.save('project', otherProject)
        const foreignFlow = createMockFlow({ projectId: otherProject.id, status: FlowStatus.ENABLED })
        await db.save('flow', foreignFlow)

        const lock = await emitLock({ token: ctx.token, projectId: ctx.project.id, resourceId: foreignFlow.id })
        expect(lock).toEqual({ acquired: false, lock: null })
    })

    it('revalidates access on every event: a member removed after joining can no longer start a run', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)

        const editorCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.EDITOR })
        const socket = await connectAndJoin({ token: editorCtx.token, projectId: ctx.project.id })
        try {
            // The socket already holds a cached EDITOR grant from the join; removing the membership
            // afterwards must be observed on the next event, exactly as it is over HTTP.
            await db.delete('project_member', { userId: editorCtx.user.id, projectId: ctx.project.id })

            const started = await emitManualTriggerOnSocket({ socket, flowVersionId: flowVersion.id, timeoutMs: PERMISSION_DENIED_WINDOW_MS })
            expect(started).toBe(false)
            // The denial also drops the project room, so project broadcasts stop reaching it.
            expect(isInRoom({ room: ctx.project.id, socketId: socket.id })).toBe(false)
        }
        finally {
            socket.disconnect()
        }
    })

    it('revalidates status on every event: a deactivated user can no longer start a run', async () => {
        const ctx = await createTestContext(app)
        const flow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED })
        await db.save('flow', flow)
        const flowVersion = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.LOCKED })
        await db.save('flow_version', flowVersion)

        const editorCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.EDITOR })
        const socket = await connectAndJoin({ token: editorCtx.token, projectId: ctx.project.id })
        try {
            // Mirrors the LDAP-reconcile deactivation path, which does not go through the eviction
            // hook: the per-event re-resolution must reject an INACTIVE user like HTTP does.
            await db.update('user', editorCtx.user.id, { status: UserStatus.INACTIVE })

            const started = await emitManualTriggerOnSocket({ socket, flowVersionId: flowVersion.id, timeoutMs: PERMISSION_DENIED_WINDOW_MS })
            expect(started).toBe(false)
            expect(isInRoom({ room: ctx.project.id, socketId: socket.id })).toBe(false)
        }
        finally {
            socket.disconnect()
        }
    })

    it('rejects presence for a resource that belongs to another project', async () => {
        const ctx = await createTestContext(app)
        const ownFlow = createMockFlow({ projectId: ctx.project.id, status: FlowStatus.ENABLED })
        await db.save('flow', ownFlow)

        const otherProject = createMockProject({ ownerId: ctx.user.id, platformId: ctx.platform.id, type: ProjectType.TEAM })
        await db.save('project', otherProject)
        const foreignFlow = createMockFlow({ projectId: otherProject.id, status: FlowStatus.ENABLED })
        await db.save('flow', foreignFlow)

        // Same-project presence works and reports the caller...
        const own = await emitPresenceJoin({ token: ctx.token, projectId: ctx.project.id, resourceId: ownFlow.id })
        expect(own.users.length).toBeGreaterThan(0)

        // ...but a resource in another project is denied rather than leaked.
        const foreign = await emitPresenceJoin({ token: ctx.token, projectId: ctx.project.id, resourceId: foreignFlow.id })
        expect(foreign).toEqual({ users: [] })

        // LEAVE is guarded too: without it, a LEAVE for another project's resource would broadcast
        // that project's active users into this one.
        const ownLeave = await emitPresenceLeave({ token: ctx.token, projectId: ctx.project.id, resourceId: ownFlow.id, timeoutMs: PERMISSION_DENIED_WINDOW_MS })
        expect(ownLeave).toBe(true)

        const foreignLeave = await emitPresenceLeave({ token: ctx.token, projectId: ctx.project.id, resourceId: foreignFlow.id, timeoutMs: PERMISSION_DENIED_WINDOW_MS })
        expect(foreignLeave).toBe(false)
    })
})

describe('websocket room eviction', () => {
    it('evicts a user from the project room when they are removed from the platform', async () => {
        const ctx = await createTestContext(app)
        const memberCtx = await createMemberContext(app, ctx, { projectRole: DefaultProjectRole.EDITOR })
        const socket = await connectAndJoin({ token: memberCtx.token, projectId: ctx.project.id })
        try {
            expect(isInRoom({ room: ctx.project.id, socketId: socket.id })).toBe(true)

            const deleteRes = await ctx.delete(`/v1/users/${memberCtx.user.id}`)
            expect(deleteRes.statusCode).toBe(StatusCodes.NO_CONTENT)

            // Eviction is synchronous on the removing node; the socket stops receiving broadcasts
            // without having to emit anything first.
            expect(await waitFor({ predicate: () => !isInRoom({ room: ctx.project.id, socketId: socket.id }) })).toBe(true)
        }
        finally {
            socket.disconnect()
        }
    })

    it('evicts a demoted platform admin from a project room they were not a member of', async () => {
        const ctx = await createTestContext(app)
        // A project the admin does not own and has no membership row for: only the privileged
        // bypass admits them, so demotion must remove it.
        const otherProject = createMockProject({ ownerId: ctx.user.id, platformId: ctx.platform.id, type: ProjectType.TEAM })
        await db.save('project', otherProject)

        const socket = await connectAndJoin({ token: ctx.token, projectId: otherProject.id })
        try {
            expect(isInRoom({ room: otherProject.id, socketId: socket.id })).toBe(true)

            const updateRes = await ctx.post(`/v1/users/${ctx.user.id}`, { platformRole: PlatformRole.MEMBER })
            expect(updateRes.statusCode).toBe(StatusCodes.OK)

            expect(await waitFor({ predicate: () => !isInRoom({ room: otherProject.id, socketId: socket.id }) })).toBe(true)
        }
        finally {
            socket.disconnect()
        }
    })
})

async function expectAllowed({ token, userId, projectId }: RoomExpectation): Promise<void> {
    const socket = await connectSocket({ token, projectId })
    try {
        expect(await waitFor({ predicate: () => isInRoom({ room: projectId, socketId: socket.id }) })).toBe(true)
        // The user room is joined unconditionally, so an allowed socket must be in both.
        expect(isInRoom({ room: userId, socketId: socket.id })).toBe(true)
    }
    finally {
        socket.disconnect()
    }
}

async function expectRejected({ token, userId, projectId }: RoomExpectation): Promise<void> {
    const socket = await connectSocket({ token, projectId })
    try {
        // init joins the user room *before* the project check, so observing it proves init ran.
        expect(await waitFor({ predicate: () => isInRoom({ room: userId, socketId: socket.id }) })).toBe(true)
        // Then assert the project room stays empty for a bounded window. A single sample after an
        // arbitrary sleep could read as "rejected" while a slow (buggy) join is still in flight.
        const joined = await waitFor({
            predicate: () => isInRoom({ room: projectId, socketId: socket.id }),
            timeoutMs: REJECTION_WINDOW_MS,
        })
        expect(joined).toBe(false)
    }
    finally {
        socket.disconnect()
    }
}

function connectSocket({ token, projectId }: ConnectSocketParams): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
        const socket = ioClient(apiUrl, {
            path: '/api/socket.io',
            transports: ['websocket'],
            reconnection: false,
            auth: { token, projectId },
        })
        const onConnect = (): void => {
            cleanup()
            resolve(socket)
        }
        const onConnectError = (error: Error): void => {
            cleanup()
            socket.disconnect()
            reject(error)
        }
        const cleanup = (): void => {
            socket.off('connect', onConnect)
            socket.off('connect_error', onConnectError)
        }
        socket.on('connect', onConnect)
        socket.on('connect_error', onConnectError)
    })
}

// Read room membership from the local namespace, not `fetchSockets()`: the Redis adapter's
// `fetchSockets()` waits up to its 30 s `requestsTimeout`, which `waitFor`'s own deadline cannot
// bound — a dropped adapter response would hang the test instead of failing it. The test server is
// a single process, so the local `sockets` map is authoritative.
function isInRoom({ room, socketId }: IsInRoomParams): boolean {
    if (socketId === undefined) {
        return false
    }
    const socket = app.io.sockets.sockets.get(socketId)
    return socket !== undefined && socket.rooms.has(room)
}

async function emitManualTrigger({ token, projectId, flowVersionId, timeoutMs }: EmitManualTriggerParams): Promise<boolean> {
    const socket = await connectAndJoin({ token, projectId })
    try {
        return await emitManualTriggerOnSocket({ socket, flowVersionId, timeoutMs })
    }
    finally {
        socket.disconnect()
    }
}

function emitManualTriggerOnSocket({ socket, flowVersionId, timeoutMs }: EmitManualTriggerOnSocketParams): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs)
        const onStarted = (run: { flowVersionId: string }): void => {
            if (run.flowVersionId !== flowVersionId) {
                return
            }
            clearTimeout(timer)
            socket.off(WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED, onStarted)
            resolve(true)
        }
        socket.on(WebsocketClientEvent.MANUAL_TRIGGER_RUN_STARTED, onStarted)
        socket.emit(WebsocketServerEvent.MANUAL_TRIGGER_RUN_STARTED, { flowVersionId })
    })
}

async function emitLock({ token, projectId, resourceId }: EmitLockParams): Promise<LockResourceResponse> {
    return emitWithAck<LockResourceResponse>({
        token,
        projectId,
        event: WebsocketServerEvent.LOCK_RESOURCE,
        payload: { resourceId },
        errorLabel: 'LOCK_RESOURCE',
    })
}

async function emitPresenceJoin({ token, projectId, resourceId }: EmitPresenceJoinParams): Promise<{ users: unknown[] }> {
    return emitWithAck<{ users: unknown[] }>({
        token,
        projectId,
        event: WebsocketServerEvent.JOIN_PRESENCE,
        payload: { resourceId },
        errorLabel: 'JOIN_PRESENCE',
    })
}

async function emitPresenceLeave({ token, projectId, resourceId, timeoutMs }: EmitPresenceLeaveParams): Promise<boolean> {
    const socket = await connectAndJoin({ token, projectId })
    try {
        return await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), timeoutMs)
            const onUpdated = (event: { resourceId: string }): void => {
                if (event.resourceId !== resourceId) {
                    return
                }
                clearTimeout(timer)
                socket.off(WebsocketClientEvent.PRESENCE_UPDATED, onUpdated)
                resolve(true)
            }
            socket.on(WebsocketClientEvent.PRESENCE_UPDATED, onUpdated)
            socket.emit(WebsocketServerEvent.LEAVE_PRESENCE, { resourceId })
        })
    }
    finally {
        socket.disconnect()
    }
}

async function emitWithAck<T>({ token, projectId, event, payload, errorLabel }: EmitWithAckParams): Promise<T> {
    const socket = await connectAndJoin({ token, projectId })
    try {
        return await new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${errorLabel} ack timed out`)), 3000)
            socket.emit(event, payload, (response: T) => {
                clearTimeout(timer)
                resolve(response)
            })
        })
    }
    finally {
        socket.disconnect()
    }
}

// init registers the listeners only after it has joined the project room, so an event emitted on
// the raw `connect` can land before the handler exists. Wait for the room first.
async function connectAndJoin({ token, projectId }: ConnectSocketParams): Promise<ClientSocket> {
    const socket = await connectSocket({ token, projectId })
    const joined = await waitFor({ predicate: () => isInRoom({ room: projectId, socketId: socket.id }) })
    if (!joined) {
        socket.disconnect()
        throw new Error(`socket did not join project room ${projectId}`)
    }
    await sleep(50)
    return socket
}

async function waitFor({ predicate, timeoutMs = 3000 }: WaitForParams): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) {
            return true
        }
        await sleep(25)
    }
    return false
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

type RoomExpectation = {
    token: string
    userId: string
    projectId: string
}

type ConnectSocketParams = {
    token: string
    projectId: string
}

type IsInRoomParams = {
    room: string
    socketId: string | undefined
}

type WaitForParams = {
    predicate: () => boolean
    timeoutMs?: number
}

type EmitManualTriggerParams = {
    token: string
    projectId: string
    flowVersionId: string
    timeoutMs: number
}

type EmitManualTriggerOnSocketParams = {
    socket: ClientSocket
    flowVersionId: string
    timeoutMs: number
}

type EmitLockParams = {
    token: string
    projectId: string
    resourceId: string
}

type EmitPresenceJoinParams = {
    token: string
    projectId: string
    resourceId: string
}

type EmitPresenceLeaveParams = {
    token: string
    projectId: string
    resourceId: string
    timeoutMs: number
}

type EmitWithAckParams = {
    token: string
    projectId: string
    event: WebsocketServerEvent
    payload: Record<string, unknown>
    errorLabel: string
}
