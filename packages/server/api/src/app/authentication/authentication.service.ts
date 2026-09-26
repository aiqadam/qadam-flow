import { cryptoUtils } from '@aiqadam/server-utils'
import { ApFlagId, assertNotNullOrUndefined, AuthenticationResponse, ErrorCode, FederatedIdentityProvider, isNil, OtpType, PlatformRole, PlatformWithoutSensitiveData, QadamFlowError, User, UserIdentity, UserIdentityProvider } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { flagService } from '../flags/flag.service'
import { isSmtpConfigured } from '../helper/mail/email-sender/smtp-email-sender'
import { platformService } from '../platform/platform.service'
import { userService } from '../user/user-service'
import { userInvitationsService } from '../user-invitations/user-invitation.service'
import { authenticationUtils } from './authentication-utils'
import { userFederatedIdentityService } from './federated-identity/user-federated-identity-service'
import { otpService } from './otp/otp-service'
import { userIdentityService } from './user-identity/user-identity-service'

export const authenticationService = (log: FastifyBaseLogger) => ({
    async signUp(params: SignUpParams): Promise<AuthenticationResponse> {
        const platformId = params.platformId

        if (!isNil(platformId)) {
            await authenticationUtils(log).assertEmailAuthIsEnabled({
                platformId,
                provider: params.provider,
            })
            await authenticationUtils(log).assertDomainIsAllowed({
                email: params.email,
                platformId,
            })
            await authenticationUtils(log).assertUserIsInvitedToPlatformOrProject({
                email: params.email,
                platformId,
            })
            const userIdentity = await userIdentityService(log).create({
                ...params,
                verified: true,
            })
            const user = await userService(log).getOrCreateWithProject({
                identity: userIdentity,
                platformId,
            })
            await userInvitationsService(log).provisionUserInvitation({ email: params.email })

            log.info({ email: params.email, platformId }, 'User signed up to existing platform')
            return authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId,
                projectId: null,
            })
        }

        const hasInvitations = await userInvitationsService(log).hasAnyAcceptedInvitationsForEmail({ email: params.email })
        const isFederatedProvider = params.provider === UserIdentityProvider.GOOGLE || params.provider === UserIdentityProvider.JWT || params.provider === UserIdentityProvider.SAML
        const userIdentity = await userIdentityService(log).create({
            ...params,
            verified: hasInvitations || isFederatedProvider,
        })
        await sendVerificationOrAutoVerify(userIdentity, log)
        await flagService(log).save({ id: ApFlagId.USER_CREATED, value: true })
        await authenticationUtils(log).saveNewsLetterSubscriber(userIdentity)
        await userInvitationsService(log).provisionUserInvitation({ email: params.email })

        const preferredPlatformId = await getPreferredPlatformId(userIdentity.id, log)
        if (!isNil(preferredPlatformId)) {
            const user = await userService(log).getOrCreateWithProject({
                identity: userIdentity,
                platformId: preferredPlatformId,
            })
            log.info({ email: params.email, provider: params.provider, preferredPlatformId }, 'User signed up with invitation, returning preferred platform token')
            const authResponse =  await authenticationUtils(log).getProjectAndToken({
                userId: user.id,
                platformId: preferredPlatformId,
                projectId: null,
            })
            await authenticationUtils(log).sendTelemetry({ identity: userIdentity, user, projectId: authResponse.projectId ?? '' })
            return authResponse
        }
        // GET /v1/users/me for the resulting ONBOARDING principal (platform-user-controller.ts)
        // resolves it by identityId with platformId IS NULL — bootstrap that row now, since
        // nothing else in this branch ever creates a User for an identity with no platform yet.
        // createPlatformWithProject (platform.service.ts) reuses this same row rather than
        // inserting a second one for the identity once a platform actually gets created.
        // ADMIN here (not MEMBER) matches both getOnboardingResponse's own hardcoded
        // `platformRole: ADMIN` below and the value addOwnerToPlatform promotes this same row to
        // once a platform is created — this row's role is otherwise unobservable (platformId is
        // still null, so it grants nothing), but there is no reason for it to briefly disagree.
        await userService(log).create({
            identityId: userIdentity.id,
            platformRole: PlatformRole.ADMIN,
            platformId: null,
        })
        log.info({ email: params.email, provider: params.provider }, 'User signed up without platform')
        return authenticationUtils(log).getOnboardingResponse({ identityId: userIdentity.id })

    },
    async signInWithPassword(params: SignInWithPasswordParams): Promise<AuthenticationResponse> {
        const identity = await userIdentityService(log).verifyIdentityPassword(params)
        const platformId = isNil(params.predefinedPlatformId) ? await getPreferredPlatformId(identity.id, log) : params.predefinedPlatformId

        if (isNil(platformId)) { // always cloud
            log.info({ email: params.email }, 'User signed in without an active platform on cloud, returning onboarding token')
            return authenticationUtils(log).getOnboardingResponse({ identityId: identity.id })
        }

        await authenticationUtils(log).assertEmailAuthIsEnabled({
            platformId,
            provider: UserIdentityProvider.EMAIL,
        })
        await authenticationUtils(log).assertDomainIsAllowed({
            email: params.email,
            platformId,
        })
        const user = await userService(log).getOneByIdentityAndPlatform({
            identityId: identity.id,
            platformId,
        })
        assertNotNullOrUndefined(user, 'User not found')
        log.info({ email: params.email, platformId }, 'User signed in with password')
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
        })
    },
    async federatedAuthn(params: FederatedAuthnParams): Promise<AuthenticationResponse> {
        const platformId = isNil(params.predefinedPlatformId) ? await getPreferredPlatformIdForFederatedAuthn(params.email, log) : params.predefinedPlatformId
        const userIdentity = await userIdentityService(log).getIdentityByEmail(params.email)

        if (isNil(platformId)) { // always cloud
            if (!isNil(userIdentity)) {
                return authenticationUtils(log).getOnboardingResponse({ identityId: userIdentity.id })
            }
            return authenticationService(log).signUp({
                email: params.email,
                firstName: params.firstName,
                lastName: params.lastName,
                newsLetter: params.newsLetter,
                trackEvents: params.trackEvents,
                provider: params.provider,
                platformId: null,
                password: await cryptoUtils.generateRandomPassword(),
                imageUrl: params.imageUrl,
            })
        }

        if (params.provider == UserIdentityProvider.SAML) {
            await authenticationUtils(log).assertEmailMatchesSsoDomain({
                email: params.email,
                platformId,
            })
        }

        if (isNil(userIdentity)) {
            return authenticationService(log).signUp({
                email: params.email,
                firstName: params.firstName,
                lastName: params.lastName,
                newsLetter: params.newsLetter,
                trackEvents: params.trackEvents,
                provider: params.provider,
                platformId,
                password: await cryptoUtils.generateRandomPassword(),
                imageUrl: params.imageUrl,
            })
        }
        const user = await userService(log).getOrCreateWithProject({
            identity: userIdentity,
            platformId,
        })
        await userInvitationsService(log).provisionUserInvitation({ email: params.email })
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId,
            projectId: null,
        })
    },
    async switchPlatform(params: SwitchPlatformParams): Promise<AuthenticationResponse> {
        const platforms = await platformService(log).listPlatformsForIdentityWithAtleastProject({ identityId: params.identityId })
        const platform = platforms.find((platform) => platform.id === params.platformId)
        await assertUserCanSwitchToPlatform(platform)

        assertNotNullOrUndefined(platform, 'Platform not found')
        const identity = await userIdentityService(log).getOneOrFail({ id: params.identityId })
        const user = await getUserForPlatform({ identity, platform, log })
        log.info({ userId: user.id, platformId: platform.id }, 'User switched platform')
        return authenticationUtils(log).getProjectAndToken({
            userId: user.id,
            platformId: platform.id,
            projectId: null,
            expiresInSeconds: getSwitchPlatformExpiresInSeconds({ identity, currentTokenExpiresAtSeconds: params.currentTokenExpiresAtSeconds }),
        })
    },
})

// A directory admin sets the LDAP session TTL specifically so a revoked/expired directory account
// stops holding a Qadam Flow session past that bound — `switch-platform` reissuing a fresh 7-day
// default token would silently undo that ceiling every time an LDAP-signed-in user switched
// platforms. Preferred fix over "cap by the target platform's own LDAP TTL": the token this call
// reissues is a *continuation* of the caller's own current session, not a fresh directory sign-in,
// so it must never outlive what that current token already promised — capping it at the *target*
// platform's TTL would let a caller switch onto a platform with a longer configured TTL and gain
// session time back, which the "never outlive" framing exists specifically to prevent. Every
// non-LDAP identity is unaffected: this only shortens (never extends) the default.
function getSwitchPlatformExpiresInSeconds({ identity, currentTokenExpiresAtSeconds }: GetSwitchPlatformExpiresInSecondsParams): number | undefined {
    if (identity.provider !== UserIdentityProvider.LDAP || isNil(currentTokenExpiresAtSeconds)) {
        return undefined
    }
    const remainingSeconds = currentTokenExpiresAtSeconds - Math.floor(Date.now() / 1000)
    return Math.max(remainingSeconds, 1)
}

async function assertUserCanSwitchToPlatform(platform: PlatformWithoutSensitiveData | undefined): Promise<void> {
    if (isNil(platform)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'The user is not a member of the platform',
            },
        })
    }
}

async function getUserForPlatform({ identity, platform, log }: GetUserForPlatformParams): Promise<User> {
    const user = await userService(log).getOneByIdentityAndPlatform({
        identityId: identity.id,
        platformId: platform.id,
    })
    if (isNil(user)) {
        throw new QadamFlowError({
            code: ErrorCode.AUTHORIZATION,
            params: {
                message: 'User is not member of the platform',
            },
        })
    }
    // Reverse-direction identity squatting (app-sec, round 2): a `user` row can exist here for an
    // LDAP identity without that identity ever having signed in through *this* platform's own
    // directory — e.g. via an invitation `provisionUserInvitation` granted before its own guard
    // existed, or one predating this fix. Refusing the switch unless a federated row backs it up
    // closes that path independently of whether the invitation-side guard already caught it: an
    // LDAP identity's standing access to any platform must always be provable by a federated row,
    // never by the mere existence of a `user` row.
    if (identity.provider === UserIdentityProvider.LDAP) {
        const federatedRow = await userFederatedIdentityService(log).findByUser({
            platformId: platform.id,
            userId: user.id,
            provider: FederatedIdentityProvider.LDAP,
        })
        if (isNil(federatedRow)) {
            throw new QadamFlowError({
                code: ErrorCode.AUTHORIZATION,
                params: {
                    message: 'A directory-authenticated identity must sign in through this platform\'s own directory before switching to it',
                },
            })
        }
    }
    return user
}

async function sendVerificationOrAutoVerify(userIdentity: UserIdentity, log: FastifyBaseLogger): Promise<void> {
    if (userIdentity.verified) {
        return
    }
    if (!isSmtpConfigured()) {
        await userIdentityService(log).verify(userIdentity.id)
        return
    }
    await otpService(log).createAndSend({
        platformId: null,
        email: userIdentity.email,
        type: OtpType.EMAIL_VERIFICATION,
    })
}

async function getPreferredPlatformIdForFederatedAuthn(email: string, log: FastifyBaseLogger): Promise<string | null> {
    const identity = await userIdentityService(log).getIdentityByEmail(email)
    if (isNil(identity)) {
        return null
    }
    return getPreferredPlatformId(identity.id, log)
}

async function getPreferredPlatformId(_identityId: string, _log: FastifyBaseLogger): Promise<string | null> {
    return null
}



type FederatedAuthnParams = {
    email: string
    firstName: string
    lastName: string
    newsLetter: boolean
    trackEvents: boolean
    provider: UserIdentityProvider
    predefinedPlatformId: string | null
    imageUrl?: string
}

type SignUpParams = {
    email: string
    firstName: string
    lastName: string
    password: string
    platformId: string | null
    trackEvents: boolean
    newsLetter: boolean
    provider: UserIdentityProvider
    imageUrl?: string
}

type SignInWithPasswordParams = {
    email: string
    password: string
    predefinedPlatformId: string | null
}

type SwitchPlatformParams = {
    identityId: string
    platformId: string
    currentTokenExpiresAtSeconds?: number
}

type GetSwitchPlatformExpiresInSecondsParams = {
    identity: UserIdentity
    currentTokenExpiresAtSeconds?: number
}

type GetUserForPlatformParams = {
    identity: UserIdentity
    platform: PlatformWithoutSensitiveData
    log: FastifyBaseLogger
}
