import { z } from 'zod'

// Returned instead of a session whenever the first factor succeeded but a second factor is still
// required. `mfaToken` is a short-lived, single-purpose token that is accepted *only* by the MFA
// verification/enrolment endpoints — it is not a session and grants nothing else.
export const MfaChallengeResponse = z.object({
    mfaRequired: z.literal(true),
    mfaEnrollmentRequired: z.boolean(),
    mfaToken: z.string(),
})
export type MfaChallengeResponse = z.infer<typeof MfaChallengeResponse>

export const MfaStatusResponse = z.object({
    enrolled: z.boolean(),
    recoveryCodesRemaining: z.number(),
    enforced: z.boolean(),
})
export type MfaStatusResponse = z.infer<typeof MfaStatusResponse>

export const MfaEnrollmentStartRequest = z.object({
    mfaToken: z.string().min(1),
})
export type MfaEnrollmentStartRequest = z.infer<typeof MfaEnrollmentStartRequest>

export const MfaEnrollmentStartResponse = z.object({
    secret: z.string(),
    otpauthUrl: z.string(),
})
export type MfaEnrollmentStartResponse = z.infer<typeof MfaEnrollmentStartResponse>

export const MfaEnrollmentConfirmRequest = z.object({
    mfaToken: z.string().min(1),
    code: z.string().min(6).max(32),
})
export type MfaEnrollmentConfirmRequest = z.infer<typeof MfaEnrollmentConfirmRequest>

export const MfaVerifyRequest = z.object({
    mfaToken: z.string().min(1),
    code: z.string().min(6).max(64),
})
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>

// Re-authentication for a change to an already-authenticated account. `password` is used for
// local email/password identities; `code` (a current TOTP or recovery code) is used whenever the
// identity already has MFA enrolled. Exactly which one is required depends on the identity, so
// both are optional at the schema boundary and enforced by the service.
export const MfaReauthenticationRequest = z.object({
    password: z.string().optional(),
    code: z.string().min(6).max(64).optional(),
})
export type MfaReauthenticationRequest = z.infer<typeof MfaReauthenticationRequest>

export const MfaEnrollmentConfirmAuthenticatedRequest = z.object({
    code: z.string().min(6).max(32),
})
export type MfaEnrollmentConfirmAuthenticatedRequest = z.infer<typeof MfaEnrollmentConfirmAuthenticatedRequest>

export const MfaRecoveryCodesResponse = z.object({
    recoveryCodes: z.array(z.string()),
})
export type MfaRecoveryCodesResponse = z.infer<typeof MfaRecoveryCodesResponse>

export const MfaEnrollmentConfirmResponse = MfaRecoveryCodesResponse
export type MfaEnrollmentConfirmResponse = z.infer<typeof MfaEnrollmentConfirmResponse>
