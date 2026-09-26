import {
    ApplicationEventName,
    ErrorCode,
    isNil,
    OtpType, QadamFlowError, ResetPasswordRequestBody, UserId, UserIdentityWithoutSensitiveData, VerifyEmailRequestBody } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { applicationEvents } from '../../helper/application-events'
import { userService } from '../../user/user-service'
import { otpService } from '../otp/otp-service'
import { userIdentityService } from '../user-identity/user-identity-service'

export const localAuthnService = (log: FastifyBaseLogger) => ({
    async verifyEmail({ identityId, otp }: VerifyEmailRequestBody): Promise<UserIdentityWithoutSensitiveData> {
        const isOtpValid = await otpService(log).confirm({
            identityId,
            type: OtpType.EMAIL_VERIFICATION,
            value: otp,
        })

        if (!isOtpValid) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_OTP,
                params: {},
            })
        }

        await sendAuditLogForIdentity({
            identityId,
            action: ApplicationEventName.USER_EMAIL_VERIFIED,
            log,
        })

        const identity = await userIdentityService(log).verify(identityId)
        return UserIdentityWithoutSensitiveData.parse(identity)
    },

    async resetPassword({
        identityId,
        otp,
        newPassword,
    }: ResetPasswordRequestBody): Promise<void> {
        const isOtpValid = await otpService(log).confirm({
            identityId,
            type: OtpType.PASSWORD_RESET,
            value: otp,
        })

        if (!isOtpValid) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_OTP,
                params: {},
            })
        }

        // Audited only once the password has actually changed — emitting it first (the previous
        // order) would record a successful reset in the log even on a request whose
        // `updatePassword` call then threw (e.g. an LDAP-linked identity's guard against scrambling
        // a password that no longer means anything).
        await userIdentityService(log).updatePassword({
            id: identityId,
            newPassword,
        })

        await sendAuditLogForIdentity({
            identityId,
            action: ApplicationEventName.USER_PASSWORD_RESET,
            log,
        })
    },
})

const sendAuditLogForIdentity = async ({ identityId, action, log }: SendAuditLogArgs): Promise<void> => {
    const users = await userService(log).getUsersByIdentityId({ identityId })
    for (const { id, platformId } of users) {
        if (isNil(platformId)) {
            continue
        }
        applicationEvents(log).sendUserEvent(
            {
                platformId,
                userId: id,
            },
            {
                action,
                data: {},
            },
        )
    }
}

type SendAuditLogArgs = {
    identityId: UserId
    action: ApplicationEventName.USER_EMAIL_VERIFIED | ApplicationEventName.USER_PASSWORD_RESET
    log: FastifyBaseLogger
}
