import { telegramEventPuller } from '@aiqadam/qadam-telegram-bot'
import { QadamEventPuller } from '@aiqadam/qadams-framework'

/**
 * The host's entire knowledge of any third party. A qadam appears here as one entry and nothing
 * else — the endpoint, the window length, the cursor arithmetic and the error semantics all live
 * in the qadam package behind `QadamEventPuller`.
 */
const pullers: Record<string, QadamEventPuller> = {
    '@aiqadam/qadam-telegram-bot': telegramEventPuller,
}

export const eventPullerRegistry = {
    qadamNames(): string[] {
        return Object.keys(pullers)
    },
    get(qadamName: string): QadamEventPuller | undefined {
        return pullers[qadamName]
    },
}
