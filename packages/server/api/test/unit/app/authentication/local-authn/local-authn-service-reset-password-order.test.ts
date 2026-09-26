import pino from 'pino'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// `sendAuditLogForIdentity`'s call is fire-and-forget (`applicationEvents(...).sendUserEvent` is
// not awaited), which makes "was the audit row actually written" racy to observe through a real DB
// read right after the call returns. Spying on `sendUserEvent` itself instead — synchronous, no
// timing race — is the direct way to prove the ordering: `updatePassword` must run, and succeed,
// before the audit call happens at all.
const updatePassword = vi.fn()
const sendUserEvent = vi.fn()
const confirm = vi.fn()
const getUsersByIdentityId = vi.fn()

vi.mock('../../../../../src/app/authentication/user-identity/user-identity-service', () => ({
    userIdentityService: () => ({ updatePassword }),
}))
vi.mock('../../../../../src/app/authentication/otp/otp-service', () => ({
    otpService: () => ({ confirm }),
}))
vi.mock('../../../../../src/app/user/user-service', () => ({
    userService: () => ({ getUsersByIdentityId }),
}))
vi.mock('../../../../../src/app/helper/application-events', () => ({
    applicationEvents: () => ({ sendUserEvent }),
}))

const log = pino({ level: 'silent' })

beforeEach(() => {
    vi.clearAllMocks()
    confirm.mockResolvedValue(true)
    getUsersByIdentityId.mockResolvedValue([{ id: 'user-1', platformId: 'platform-1' }])
})

describe('localAuthnService.resetPassword — audit ordering', () => {
    it('does not send USER_PASSWORD_RESET when updatePassword throws (e.g. an LDAP-linked identity)', async () => {
        const { localAuthnService } = await import('../../../../../src/app/authentication/local-authn/local-authn-service')
        updatePassword.mockRejectedValue(new Error('provider === LDAP identities cannot have a local password'))

        await expect(localAuthnService(log).resetPassword({
            identityId: 'identity-1',
            otp: '123456',
            newPassword: 'NewStrongPassword123!',
        })).rejects.toThrow()

        expect(updatePassword).toHaveBeenCalledTimes(1)
        expect(sendUserEvent).not.toHaveBeenCalled()
    })

    it('sends USER_PASSWORD_RESET only after updatePassword has already succeeded', async () => {
        const { localAuthnService } = await import('../../../../../src/app/authentication/local-authn/local-authn-service')
        updatePassword.mockResolvedValue(undefined)

        await localAuthnService(log).resetPassword({
            identityId: 'identity-1',
            otp: '123456',
            newPassword: 'NewStrongPassword123!',
        })

        expect(updatePassword).toHaveBeenCalledTimes(1)
        expect(sendUserEvent).toHaveBeenCalledTimes(1)
        const updatePasswordOrder = updatePassword.mock.invocationCallOrder[0]
        const sendUserEventOrder = sendUserEvent.mock.invocationCallOrder[0]
        expect(updatePasswordOrder).toBeLessThan(sendUserEventOrder)
    })
})
