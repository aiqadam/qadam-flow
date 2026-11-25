import { z } from 'zod'
import { User } from '../../user/user'
import { MfaChallengeResponse } from '../mfa/mfa'
import { UserIdentity } from '../user-identity'


export const UserWithoutPassword = User.pick({ id: true, platformRole: true, status: true, externalId: true, platformId: true })
export type UserWithoutPassword = z.infer<typeof UserWithoutPassword>

export const AuthenticationResponse = UserWithoutPassword.merge(
    UserIdentity.pick({ verified: true, firstName: true, lastName: true, email: true, trackEvents: true, newsLetter: true }),
).merge(
    z.object({
        token: z.string(),
        projectId: z.string().nullable(),
    }),
)
export type AuthenticationResponse = z.infer<typeof AuthenticationResponse>

// A sign-in (or sign-up on an existing platform) either produces a full session or, when a second
// factor is still required, a challenge carrying an `mfaToken` instead of a session token. The
// challenge variant never carries a `token`, so a client cannot mistake it for a usable session.
export const SignInResponse = z.union([MfaChallengeResponse, AuthenticationResponse])
export type SignInResponse = z.infer<typeof SignInResponse>

// Confirming a *forced* enrolment (the platform enforces MFA and the user had none) finishes both
// enrolment and the sign-in that was pending on it in one request, so the response carries both.
export const MfaEnrollmentConfirmWithSessionResponse = z.object({
    auth: AuthenticationResponse,
    recoveryCodes: z.array(z.string()),
})
export type MfaEnrollmentConfirmWithSessionResponse = z.infer<typeof MfaEnrollmentConfirmWithSessionResponse>
