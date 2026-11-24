import { UserIdentity } from '@aiqadam/shared'
import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../../database/database-common'

export const UserIdentityEntity = new EntitySchema<UserIdentity>({
    name: 'user_identity',
    columns: {
        ...BaseColumnSchemaPart,
        email: {
            type: String,
            nullable: false,
            unique: true,
        },
        password: {
            type: String,
        },
        trackEvents: {
            type: Boolean,
            nullable: true,
        },
        newsLetter: {
            type: Boolean,
            nullable: true,
        },
        verified: {
            type: Boolean,
            nullable: false,
            default: false,
        },
        firstName: {
            type: String,
            nullable: false,
        },
        lastName: {
            type: String,
            nullable: false,
        },
        tokenVersion: {
            type: String,
            nullable: true,
        },
        provider: {
            type: String,
            nullable: false,
        },
        imageUrl: {
            type: String,
            nullable: true,
        },
        lastLoggedInPlatformId: {
            ...ApIdSchema,
            nullable: true,
        },
        mfaEnabled: {
            type: Boolean,
            nullable: false,
            default: false,
        },
        // AES-encrypted at rest by `encryptUtils` (same shape as the LDAP bind password) — never
        // returned over the API, never logged.
        mfaSecret: {
            type: 'json',
            nullable: true,
        },
        // The secret pending confirmation during enrolment. Kept separate from `mfaSecret` so a
        // half-finished enrolment can never become the active secret, and so starting a second
        // enrolment cannot silently replace an active one.
        mfaPendingSecret: {
            type: 'json',
            nullable: true,
        },
        // SHA-256 hashes of the one-time recovery codes; the plaintext is shown once at enrolment.
        mfaRecoveryCodes: {
            type: 'json',
            nullable: true,
        },
        mfaEnrolledAt: {
            type: 'timestamp with time zone',
            nullable: true,
        },
        // Highest TOTP time-step ever accepted for this identity — the replay guard. A code for a
        // step at or below this value is refused even though it would otherwise validate.
        mfaLastUsedStep: {
            type: 'bigint',
            nullable: true,
            transformer: {
                to: (value: number | null | undefined) => value,
                from: (value: string | null) => (value === null ? null : Number(value)),
            },
        },
    },
    indices: [
        {
            name: 'idx_user_identity_email',
            columns: ['email'],
            unique: true,
        },
    ],
})
