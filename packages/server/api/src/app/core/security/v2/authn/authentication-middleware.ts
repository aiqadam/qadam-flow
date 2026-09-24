import { isNil } from '@aiqadam/shared'
import { FastifyRequest } from 'fastify'
import { RouteKind } from '../../authorization/common'
import { assertPrincipalAdmitted } from '../authz/authorize'
import { authenticateOrThrow } from './authenticate'

// Registered as a `preValidation` hook, so it runs before the body schema does. A
// missing token does not throw here — it yields an UNKNOWN principal — so the principal
// type is checked here too; otherwise an anonymous caller would still reach body
// validation and only be turned away afterwards, by authorizationMiddleware.
export const authenticationMiddleware = async (request: FastifyRequest): Promise<void> => {
    const security = request.routeOptions.config?.security
    // Todo(@chaker): remove this once we remove v1 authn
    if (isNil(security)) {
        return
    }
    if (security.kind === RouteKind.PUBLIC) {
        return
    }

    const principal = await authenticateOrThrow(request.log, request.headers['authorization'] ?? null)
    request.principal = principal
    await assertPrincipalAdmitted({ principal, security })
}
