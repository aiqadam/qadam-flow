import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { qadamPinMoveController } from './qadam-pin-move.controller'

export const qadamPinMoveModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(qadamPinMoveController, { prefix: '/v1/qadam-pin-moves' })
}
