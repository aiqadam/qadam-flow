import { z } from 'zod'
import { BaseModelSchema, DateOrString, Nullable } from '../common'

// The shape the server's at-rest encryption helper stores (an AES-CBC IV plus hex ciphertext).
// Declared here only so the identity model can describe the (never-returned) columns; it is not
// part of any response a client receives.
export const MfaEncryptedValue = z.object({
    iv: z.string(),
    data: z.string(),
})
export type MfaEncryptedValue = z.infer<typeof MfaEncryptedValue>


export enum UserIdentityProvider {
    EMAIL = 'EMAIL',
    GOOGLE = 'GOOGLE',
    SAML = 'SAML',
    JWT = 'JWT',
    LDAP = 'LDAP',
}
export const UserIdentity = z.object({
    ...BaseModelSchema,
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    password: z.string(),
    trackEvents: z.boolean(),
    newsLetter: z.boolean(),
    verified: z.boolean(),
    tokenVersion: z.string().optional(),
    provider: z.nativeEnum(UserIdentityProvider),
    imageUrl: Nullable(z.string()),
    lastLoggedInPlatformId: Nullable(z.string()),
    mfaEnabled: z.boolean().optional(),
    mfaSecret: MfaEncryptedValue.nullable().optional(),
    mfaPendingSecret: MfaEncryptedValue.nullable().optional(),
    mfaRecoveryCodes: z.array(z.string()).nullable().optional(),
    mfaEnrolledAt: Nullable(DateOrString).optional(),
    mfaLastUsedStep: Nullable(z.number()).optional(),
})

export type UserIdentity = z.infer<typeof UserIdentity>

export const UserIdentityWithoutSensitiveData = UserIdentity.omit({
    password: true,
    tokenVersion: true,
    mfaSecret: true,
    mfaPendingSecret: true,
    mfaRecoveryCodes: true,
    mfaLastUsedStep: true,
})

export type UserIdentityWithoutSensitiveData = z.infer<typeof UserIdentityWithoutSensitiveData>
