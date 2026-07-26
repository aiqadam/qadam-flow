import { isNil } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'



export const hooksFactory = {
    create<T>(defaultHooks: (log: FastifyBaseLogger) => T) {
        let hooksCreator: (log: FastifyBaseLogger) => T
        return {
            set(newHooksCreator: (log: FastifyBaseLogger) => T): void {
                if (!isNil(hooksCreator)) {
                    throw new Error('hooksFactory.set() called more than once for the same hook instance — a second caller would silently replace the first implementation instead of composing with it.')
                }
                hooksCreator = newHooksCreator
            },
            get(log: FastifyBaseLogger): T {
                if (isNil(hooksCreator)) {
                    return defaultHooks(log)
                }
                return hooksCreator(log)
            },
        }
    },
}