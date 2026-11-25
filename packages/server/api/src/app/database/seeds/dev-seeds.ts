import { ApEnvironment, UserIdentityProvider } from '@aiqadam/shared'
import { authenticationService } from '../../authentication/authentication.service'
import { FlagEntity } from '../../flags/flag.entity'
import { system } from '../../helper/system/system'
import { AppSystemProp } from '../../helper/system/system-props'
import { platformService } from '../../platform/platform.service'
import { databaseConnection } from '../database-connection'
import { DataSeed } from './data-seed'

const DEV_DATA_SEEDED_FLAG = 'DEV_DATA_SEEDED'
const log = system.globalLogger()

const currentEnvIsNotDev = (): boolean => {
    const env = system.get(AppSystemProp.ENVIRONMENT)
    return env !== ApEnvironment.DEVELOPMENT
}

const devDataAlreadySeeded = async (): Promise<boolean> => {
    const flagRepo = databaseConnection().getRepository(FlagEntity)
    const devSeedsFlag = await flagRepo.findOneBy({ id: DEV_DATA_SEEDED_FLAG })
    return devSeedsFlag?.value === true
}

const setDevDataSeededFlag = async (): Promise<void> => {
    const flagRepo = databaseConnection().getRepository(FlagEntity)

    await flagRepo.save({
        id: DEV_DATA_SEEDED_FLAG,
        value: true,
    })
}

const seedDevUser = async (): Promise<void> => {
    const DEV_EMAIL = 'dev@ap.com'
    const DEV_PASSWORD = '12345678'


    const response = await authenticationService(log).signUp({
        email: DEV_EMAIL,
        password: DEV_PASSWORD,
        firstName: 'Dev',
        lastName: 'User',
        trackEvents: false,
        platformId: null,
        newsLetter: false,
        provider: UserIdentityProvider.EMAIL,
    })

    // Sign-up with `platformId: null` always returns the onboarding response, never an MFA
    // challenge (that gate only runs once a platform is known) — this is a type-level narrowing
    // for the dev seed script, not a real runtime possibility here.
    if ('mfaRequired' in response) {
        throw new Error('[devSeeds#seedDevUser] Unexpected MFA challenge for a platformless dev sign-up')
    }

    await platformService(log).createPlatformWithProject({
        identityId: response.id,
        name: 'dev\'s Platform',
        invalidatePreviousTokens: true,
    })

    log.info({ email: DEV_EMAIL, password: DEV_PASSWORD }, '[devSeeds#seedDevUser] Dev user and platform created')
}
const seedDevData = async (): Promise<void> => {
    if (currentEnvIsNotDev()) {
        log.info('[devSeeds#seedDevData] Skipping, not in development environment')
        return
    }

    if (await devDataAlreadySeeded()) {
        log.info('[devSeeds#seedDevData] Skipping, already seeded')
        return
    }

    await seedDevUser()
    await setDevDataSeededFlag()
}

export const devDataSeed: DataSeed = {
    run: seedDevData,
}
