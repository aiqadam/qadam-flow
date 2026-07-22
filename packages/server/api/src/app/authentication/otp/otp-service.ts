import { timingSafeEqual } from 'node:crypto'
import {
    apId,
    isNil,
    OtpModel,
    OtpState,
    OtpType, PlatformId } from '@aiqadam/shared'
import dayjs from 'dayjs'
import { FastifyBaseLogger } from 'fastify'
import { repoFactory } from '../../core/db/repo-factory'
import { emailService } from '../../helper/mail/email-service'
import { userIdentityService } from '../user-identity/user-identity-service'
import { OtpEntity } from './otp-entity'
import { otpGenerator } from './otp-generator'

const TEN_MINUTES = 10 * 60 * 1000

const repo = repoFactory(OtpEntity)

export const otpService = (log: FastifyBaseLogger) => ({
    async createAndSend({
        platformId,
        email,
        type,
    }: CreateParams): Promise<void> {
        const userIdentity = await userIdentityService(log).getIdentityByEmail(email)
        if (!userIdentity) {
            return
        }
        const existingOtp = await repo().findOneBy({
            identityId: userIdentity.id,
            type,
        })
        const otpIsNotExpired = existingOtp && dayjs().diff(existingOtp.updated, 'milliseconds') < TEN_MINUTES
        if (otpIsNotExpired) {
            return
        }
        const newOtp: Omit<OtpModel, 'created'> = {
            id: apId(),
            updated: dayjs().toISOString(),
            type,
            identityId: userIdentity.id,
            value: otpGenerator.generate(),
            state: OtpState.PENDING,
        }
        await repo().upsert(newOtp, ['identityId', 'type'])
        await emailService(log).sendOtp({
            platformId,
            userIdentity,
            otp: newOtp.value,
            type: newOtp.type,
        })
    },

    async confirm({ identityId, type, value }: ConfirmParams): Promise<boolean> {
        const otp = await repo().findOneBy({
            identityId,
            type,
        })
        if (isNil(otp)) {
            return false
        }
        const otpIsPending = otp.state === OtpState.PENDING
        const otpIsNotExpired = dayjs().diff(otp.updated, 'milliseconds') < TEN_MINUTES
        const otpMatches = constantTimeEquals(otp.value, value)
        const verdict = otpIsNotExpired && otpMatches && otpIsPending
        if (verdict) {
            await repo().update(otp.id, {
                state: OtpState.CONFIRMED,
            })
        }

        return verdict
    },
})

function constantTimeEquals(a: string, b: string): boolean {
    const bufferA = Buffer.from(a, 'utf-8')
    const bufferB = Buffer.from(b, 'utf-8')
    if (bufferA.length !== bufferB.length) {
        return false
    }
    return timingSafeEqual(bufferA, bufferB)
}

type CreateParams = {
    platformId: PlatformId | null
    email: string
    type: OtpType
}

type ConfirmParams = {
    identityId: string
    type: OtpType
    value: string
}
