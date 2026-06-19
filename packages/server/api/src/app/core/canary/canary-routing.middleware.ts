import '@fastify/reply-from'
import { FastifyReply, FastifyRequest } from 'fastify'

export const canaryRoutingMiddleware = async (_request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    return
}

