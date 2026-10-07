import { FastifyBaseLogger } from 'fastify'

export const exceptionHandler = {
    handle: (e: unknown, log: FastifyBaseLogger): void => {
        log.error({ err: e }, 'Unhandled exception')
    },
}
