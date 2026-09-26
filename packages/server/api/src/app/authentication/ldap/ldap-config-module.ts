import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ldapConfigController } from './ldap-config-controller'

export const ldapConfigModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(ldapConfigController, { prefix: '/v1/platform-ldap-configs' })
}
