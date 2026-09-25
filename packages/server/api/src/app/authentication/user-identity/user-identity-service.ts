import { cryptoUtils } from '@aiqadam/server-utils'
import { apId, ErrorCode, isNil, QadamFlowError, spreadIfDefined, UserIdentity, UserIdentityProvider } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { nanoid } from 'nanoid'
import { repoFactory } from '../../core/db/repo-factory'
import { passwordHasher } from '../lib/password-hasher'
import { UserIdentityEntity } from './user-identity-entity'

export const userIdentityRepository = repoFactory(UserIdentityEntity)

export const userIdentityService = (log: FastifyBaseLogger) => ({
    async create(params: Pick<UserIdentity, 'email' | 'password' | 'firstName' | 'lastName' | 'trackEvents' | 'newsLetter' | 'provider' | 'verified'> & { imageUrl?: string }): Promise<UserIdentity> {
        log.info({
            email: params.email,
        }, 'Creating user identity')

        const cleanedEmail = params.email.toLowerCase().trim()
        const hashedPassword = await passwordHasher.hash(params.password)
        const userByEmail = await userIdentityRepository().findOne({ where: { email: cleanedEmail } })
        if (userByEmail) {
            throw new QadamFlowError({
                code: ErrorCode.EXISTING_USER,
                params: {
                    email: cleanedEmail,
                    platformId: null,
                },
            })
        }
        const newUserIdentity: UserIdentity = {
            firstName: params.firstName,
            lastName: params.lastName,
            provider: params.provider,
            email: cleanedEmail,
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            verified: params.verified,
            id: apId(),
            password: hashedPassword,
            trackEvents: params.trackEvents,
            newsLetter: params.newsLetter,
            tokenVersion: nanoid(),
            imageUrl: params.imageUrl,
        }
        const identity = await userIdentityRepository().save(newUserIdentity)
        return identity
    },
    async verifyIdentityPassword(params: VerifyIdentityPasswordParams): Promise<UserIdentity> {
        const userIdentity = await getIdentityByEmail(params.email)
        // An LDAP-managed identity's stored `password` is a scrambled, never-issued value (see
        // `linkToFederatedProvider` below) — reusing it against a caller-supplied password one day
        // could line up by coincidence, so this is a hard code-path exclusion, not a bet on the
        // hash never matching. The response is identical to "no such identity" (`INVALID_
        // CREDENTIALS`, no distinguishing detail) so a caller cannot use this endpoint to discover
        // that an email is provisioned via the directory.
        if (!isNil(userIdentity) && userIdentity.provider === UserIdentityProvider.LDAP) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_CREDENTIALS,
                params: null,
            })
        }
        if (isNil(userIdentity)) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_CREDENTIALS,
                params: null,
            })
        }
        if (!userIdentity.verified) {
            throw new QadamFlowError({
                code: ErrorCode.EMAIL_IS_NOT_VERIFIED,
                params: {
                    email: userIdentity.email,
                },
            })
        }

        const passwordMatches = await passwordHasher.compare(params.password, userIdentity.password)
        if (!passwordMatches) {
            throw new QadamFlowError({
                code: ErrorCode.INVALID_CREDENTIALS,
                params: null,
            })
        }
        return userIdentity
    },
    async getIdentityByEmail(email: string): Promise<UserIdentity | null> {
        const cleanedEmail = email.toLowerCase().trim()
        return userIdentityRepository().findOneBy({ email: cleanedEmail })
    },
    async getOneOrFail(params: GetOneOrFailParams): Promise<UserIdentity> {
        const userIdentity = await userIdentityRepository().findOneByOrFail({ id: params.id })
        return userIdentity
    },
    async getBasicInformation(id: string): Promise<Pick<UserIdentity, 'email' | 'firstName' | 'lastName' | 'trackEvents' | 'newsLetter' | 'imageUrl'>> {
        const user = await userIdentityRepository().findOneByOrFail({ id })
        return {
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            trackEvents: user.trackEvents,
            newsLetter: user.newsLetter,
            imageUrl: user.imageUrl,
        }
    },
    async updatePassword(params: UpdatePasswordParams): Promise<void> {
        const identity = await userIdentityRepository().findOneByOrFail({ id: params.id })
        if (identity.provider === UserIdentityProvider.LDAP) {
            throw new QadamFlowError({
                code: ErrorCode.VALIDATION,
                params: {
                    message: 'This account is managed by an LDAP directory and cannot change its password locally',
                },
            })
        }
        const hashedPassword = await passwordHasher.hash(params.newPassword)
        await userIdentityRepository().update(params.id, {
            password: hashedPassword,
            tokenVersion: nanoid(),
        })
    },
    // Used only by the LDAP JIT "link existing account by email" path: the identity keeps its row
    // (email, id, history) but stops being reachable by local password sign-in, OTP password reset
    // or password change from this moment on — `verifyIdentityPassword`/`updatePassword` above and
    // the OTP PASSWORD_RESET paths all exclude `UserIdentityProvider.LDAP`. The password is
    // scrambled to a value nobody (including this identity's own former owner) ever received,
    // rather than left as whatever the local password used to be, so a stale local credential
    // cannot resurface as a bypass. Runs before the `provider` write, not after, so it goes through
    // the ordinary `updatePassword` guard rather than being a second exception to it.
    async linkToFederatedProvider({ id, provider }: LinkToFederatedProviderParams): Promise<void> {
        await this.updatePassword({ id, newPassword: await cryptoUtils.generateRandomPassword() })
        await userIdentityRepository().update(id, {
            provider,
            tokenVersion: nanoid(),
        })
    },
    async verify(id: string): Promise<UserIdentity> {
        const user = await userIdentityRepository().findOneByOrFail({ id })
        if (user.verified) {
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'User is already verified',
                },
            })
        }
        return userIdentityRepository().save({
            ...user,
            verified: true,
        })
    },
    async update(id: string, params: UpdateParams): Promise<void> {
        await userIdentityRepository().update(id, {
            ...params,
            ...spreadIfDefined('password', params.password ? await passwordHasher.hash(params.password) : undefined),
        })
    },
    async updateLastLoggedInPlatformId({ id, lastLoggedInPlatformId }: UpdateLastLoggedInPlatformIdParams): Promise<void> {
        await userIdentityRepository().update(id, { lastLoggedInPlatformId })
    },
})


async function getIdentityByEmail(email: string): Promise<UserIdentity | null> {
    const cleanedEmail = email.toLowerCase().trim()
    return userIdentityRepository().findOneBy({ email: cleanedEmail })
}

type GetOneOrFailParams = {
    id: string
}

type UpdatePasswordParams = {
    id: string
    newPassword: string
}

type UpdateParams = {
    firstName?: string
    lastName?: string
    password?: string
    imageUrl?: string | null
}

type UpdateLastLoggedInPlatformIdParams = {
    id: string
    lastLoggedInPlatformId: string
}

type VerifyIdentityPasswordParams = {
    email: string
    password: string
}

type LinkToFederatedProviderParams = {
    id: string
    provider: UserIdentityProvider
}
