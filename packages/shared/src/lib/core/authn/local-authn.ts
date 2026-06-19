import { z } from 'zod'
import { SignUpRequest } from '../authentication/dto/sign-up-request'

export const VerifyEmailRequestBody = z.object({
    identityId: z.string(),
    otp: z.string(),
})
export type VerifyEmailRequestBody = z.infer<typeof VerifyEmailRequestBody>

export const ResetPasswordRequestBody = z.object({
    identityId: z.string(),
    otp: z.string(),
    newPassword: z.string(),
})
export type ResetPasswordRequestBody = z.infer<typeof ResetPasswordRequestBody>

export const SignUpAndAcceptRequestBody = SignUpRequest.omit({ email: true }).extend({
    invitationToken: z.string(),
})
export type SignUpAndAcceptRequestBody = z.infer<typeof SignUpAndAcceptRequestBody>
