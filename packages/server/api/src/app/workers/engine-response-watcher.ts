import { apId } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { pubsub } from '../helper/pubsub'

const listeners = new Map<string, ListenerEntry>()
const SERVER_ID = apId()

export const engineResponseWatcher = (log: FastifyBaseLogger) => ({
    getServerId(): string {
        return SERVER_ID
    },

    async init(): Promise<void> {
        log.info('[engineResponseWatcher#init] Initializing engine run watcher')
        await pubsub.subscribe(
            `engine-run:sync:${SERVER_ID}`,
            (message: string) => {
                const parsedMessage: EngineResponseWithId<unknown> = JSON.parse(message)
                const entry = listeners.get(parsedMessage.requestId)

                if (entry) {
                    entry.onResponse(parsedMessage)
                }

                log.info(
                    { requestId: parsedMessage.requestId },
                    '[engineWatcher#init]',
                )
            },
        )
    },

    // requestId must be unique per caller (e.g. a fresh apId() minted by the caller), never a
    // process-wide or shared value — two listeners sharing a key overwrite each other in the
    // map below and one caller silently receives the other's response.
    //
    // Returns the response promise together with a cancel() closed over this exact registration
    // (`entry`), never a key-based lookup. With every caller now keying by a fresh per-request
    // id, nothing should ever register two listeners under the same key — but the identity guard
    // is kept as defence-in-depth: if a key ever did collide (a bug elsewhere, or a future
    // caller reusing an id), whichever registers second overwrites the map entry, and each
    // caller's own `cancel()` still only ever acts on the entry it closed over, so cancelling the
    // loser can never tear down the winner's listener, and cancelling a listener that has already
    // been overwritten in the map is a no-op on the map (it still resolves that caller's own
    // promise with defaultResponse).
    oneTimeListener<T>(requestId: string, timeoutRequest: boolean, timeoutMs: number | undefined, defaultResponse: T): OneTimeListener<T> {
        log.info('[engineWatcher#listen]')

        let timeout: NodeJS.Timeout | undefined
        let resolvePromise: (value: T) => void
        const promise = new Promise<T>((resolve) => {
            resolvePromise = resolve
        })

        // A stale timeout or response must never delete an entry that has since been
        // replaced under the same key — only remove it while it is still this listener's own.
        const deleteIfOwnEntry = (): void => {
            if (listeners.get(requestId) === entry) {
                listeners.delete(requestId)
            }
        }

        // The listener map is untyped by T (it holds every in-flight request's entry
        // regardless of that caller's own response type), so the value published over pubsub
        // is only known as `unknown` here; this cast is the one place that reconnects it to
        // the caller's T and cannot be removed without giving the map itself a runtime type
        // guard per T, which no caller here needs or provides.
        const onResponse = (flowResponse: EngineResponseWithId<unknown>): void => {
            if (timeout) {
                clearTimeout(timeout)
            }
            deleteIfOwnEntry()
            log.info({ requestId }, '[engineWatcher#listen] Response received')
            resolvePromise(flowResponse.response as T)
        }

        const cancel = (): void => {
            if (timeout) {
                clearTimeout(timeout)
            }
            deleteIfOwnEntry()
            resolvePromise(defaultResponse)
        }

        const entry: ListenerEntry = { onResponse, cancel }

        if (timeoutRequest) {
            timeout = setTimeout(() => {
                log.info('[engineWatcher#listen] Timeout reached')
                cancel()
            }, timeoutMs)
        }

        listeners.set(requestId, entry)

        return { promise, cancel }
    },

    async publish(webserverId: string, requestId: string, response: unknown): Promise<void> {
        await pubsub.publish(
            `engine-run:sync:${webserverId}`,
            JSON.stringify({ requestId, response }),
        )
    },

    async shutdown(): Promise<void> {
        await pubsub.unsubscribe(`engine-run:sync:${SERVER_ID}`)
    },
})

type EngineResponseWithId<T> = { requestId: string, response: T }
type ListenerEntry = {
    onResponse: (flowResponse: EngineResponseWithId<unknown>) => void
    cancel: () => void
}
type OneTimeListener<T> = {
    promise: Promise<T>
    cancel: () => void
}
