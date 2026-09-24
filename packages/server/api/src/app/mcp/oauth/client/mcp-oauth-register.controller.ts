import { BoundedArray } from '@aiqadam/shared'
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { securityAccess } from '../../../core/security/authorization/fastify-security'
import { mcpOAuthClientService } from './mcp-oauth-client.service'

export const mcpOAuthRegisterController: FastifyPluginAsyncZod = async (app) => {

    app.post('/register', RegisterRequest, async (req, reply) => {
        const { redirect_uris, client_name, grant_types, token_endpoint_auth_method } = req.body

        const result = await mcpOAuthClientService.register({
            redirectUris: redirect_uris,
            clientName: client_name,
            grantTypes: grant_types,
            tokenEndpointAuthMethod: token_endpoint_auth_method,
        })

        return reply.status(201).send(result)
    })
}

function isPrivateUseScheme(protocol: string): boolean {
    const scheme = protocol.replace(/:$/, '')
    return /^[a-z][a-z0-9+\-.]*\.[a-z][a-z0-9+\-.]*$/.test(scheme)
        || ['cursor', 'vscode', 'vscode-insiders', 'windsurf', 'claude'].includes(scheme)
}

// A public, unauthenticated route: dynamic client registration (RFC 7591) sets no limits of
// its own, and real MCP clients register one or two redirect URIs.
const MAX_REDIRECT_URIS = 20
const MAX_GRANT_OR_RESPONSE_TYPES = 10

const RegisterRequest = {
    config: { security: securityAccess.public() },
    schema: {
        hide: true,
        body: z.object({
            // zod runs a refine even after `url()` has rejected the value, so the refine
            // must not assume a parseable URL: an unguarded `new URL` throws out of the
            // validator on the first malformed entry.
            redirect_uris: BoundedArray({
                element: z.url().refine((uri) => {
                    if (!URL.canParse(uri)) {
                        return false
                    }
                    const scheme = new URL(uri).protocol
                    return scheme === 'http:' || scheme === 'https:' || isPrivateUseScheme(scheme)
                }, { message: 'Only http, https, or private-use URI schemes (RFC 8252) are allowed' }),
                max: MAX_REDIRECT_URIS,
                nonEmpty: true,
            }),
            client_name: z.string().max(255).optional(),
            grant_types: BoundedArray({ element: z.string(), max: MAX_GRANT_OR_RESPONSE_TYPES }).optional(),
            response_types: BoundedArray({ element: z.string(), max: MAX_GRANT_OR_RESPONSE_TYPES }).optional(),
            token_endpoint_auth_method: z.enum(['none', 'client_secret_post']).optional(),
        }),
    },
}
