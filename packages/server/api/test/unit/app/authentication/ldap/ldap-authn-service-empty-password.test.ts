import { ErrorCode, QadamFlowError, tryCatch } from '@aiqadam/shared'
import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getResolvedForSignIn = vi.fn()
const findBySubject = vi.fn()
const getIdentityByEmail = vi.fn()
const connect = vi.fn()

vi.mock('../../../../../src/app/authentication/ldap/ldap-config-service', () => ({
    ldapConfigService: () => ({ getResolvedForSignIn }),
}))
vi.mock('../../../../../src/app/authentication/federated-identity/user-federated-identity-service', () => ({
    userFederatedIdentityService: () => ({ findBySubject }),
}))
vi.mock('../../../../../src/app/authentication/user-identity/user-identity-service', () => ({
    userIdentityService: () => ({ getIdentityByEmail }),
}))
vi.mock('../../../../../src/app/authentication/ldap/ldap-client', () => ({
    ldapClient: {
        connect,
        withConnectionSlot: (fn: () => unknown) => fn(),
        serviceBind: vi.fn(),
        searchForUser: vi.fn(),
        bindAsUser: vi.fn(),
    },
}))

const log = pino({ level: 'silent' })

describe('ldapAuthnService.signIn — empty password', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('refuses an empty password before reading the platform config or touching the network', async () => {
        const { ldapAuthnService } = await import('../../../../../src/app/authentication/ldap/ldap-authn-service')

        const { error } = await tryCatch(() => ldapAuthnService(log).signIn({ platformId: 'platform-1', username: 'jdoe', password: '' }))

        expect(error).toBeInstanceOf(QadamFlowError)
        expect(error instanceof QadamFlowError ? error.error.code : undefined).toBe(ErrorCode.INVALID_CREDENTIALS)

        expect(getResolvedForSignIn).not.toHaveBeenCalled()
        expect(findBySubject).not.toHaveBeenCalled()
        expect(getIdentityByEmail).not.toHaveBeenCalled()
        expect(connect).not.toHaveBeenCalled()
    })
})
