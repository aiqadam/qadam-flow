import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { ldapAuthnController } from './ldap-authn-controller'

export const ldapAuthnModule: FastifyPluginAsyncZod = async (app) => {
    await app.register(ldapAuthnController, { prefix: '/v1/authn/ldap' })
}
