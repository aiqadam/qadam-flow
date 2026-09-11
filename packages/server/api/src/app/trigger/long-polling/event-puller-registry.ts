import { QadamEventPuller } from '@aiqadam/qadams-framework'
import { isNil } from '@aiqadam/shared'

/**
 * The host's entire knowledge of any third party. A qadam appears here as one entry and nothing
 * else — the endpoint, the window length, the cursor arithmetic and the error semantics all live
 * in the qadam package behind `QadamEventPuller`.
 *
 * Loaded on demand rather than at module scope, so an instance with the feature flag off never
 * evaluates a community qadam's module graph inside the process that serves user requests. Keeping
 * this list hardcoded is also the only real containment against a puller that wedges the event
 * loop, since the host runs qadam code unsandboxed — do not make it dynamic.
 */
const loaders: Record<string, () => Promise<QadamEventPuller>> = {
    '@aiqadam/qadam-telegram-bot': async () => (await import('@aiqadam/qadam-telegram-bot')).telegramEventPuller,
}

let pullers: Record<string, QadamEventPuller> | undefined

export const eventPullerRegistry = {
    async load(): Promise<void> {
        if (!isNil(pullers)) {
            return
        }
        const loaded = await Promise.all(
            Object.entries(loaders).map(async ([qadamName, loader]) => [qadamName, await loader()] as const),
        )
        pullers = Object.fromEntries(loaded)
    },
    /** Answerable without evaluating any qadam, so callers can bail out before paying for a load. */
    isRegistered(qadamName: string): boolean {
        return !isNil(loaders[qadamName])
    },
    async getOrLoad(qadamName: string): Promise<QadamEventPuller | undefined> {
        if (!this.isRegistered(qadamName)) {
            return undefined
        }
        await this.load()
        return this.get(qadamName)
    },
    qadamNames(): string[] {
        return Object.keys(pullers ?? {})
    },
    get(qadamName: string): QadamEventPuller | undefined {
        return pullers?.[qadamName]
    },
}
