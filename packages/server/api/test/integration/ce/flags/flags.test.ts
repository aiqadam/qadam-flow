import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { defaultTheme } from '../../../../src/app/flags/theme'
import { mockAndSaveBasicSetup } from '../../../helpers/mocks'
import { cleanDatabase, setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    // Each branding case below relies on being the *only* platform in the DB,
    // since an anonymous /v1/flags caller resolves branding via the oldest
    // platform (see resolvePlatformTheme in flag.service.ts). Without this,
    // a platform saved by an earlier test can outrank the one this test
    // creates, depending on the random `created` timestamps mocks assign.
    await cleanDatabase()
})

describe('Flags API', () => {
    describe('GET /v1/flags', () => {
        it('should return flags without authentication', async () => {
            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/flags',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body).toHaveProperty('ENVIRONMENT')
            expect(typeof body.ENVIRONMENT).toBe('string')
            expect(body).toHaveProperty('WEBHOOK_URL_PREFIX')
            expect(typeof body.WEBHOOK_URL_PREFIX).toBe('string')
        })

        it('serves the platform\'s configured branding instead of the hardcoded default', async () => {
            const { mockPlatform } = await mockAndSaveBasicSetup({
                platform: {
                    name: 'Acme Corp',
                    primaryColor: '#123456',
                    fullLogoUrl: 'https://example.com/full-logo.png',
                    favIconUrl: 'https://example.com/favicon.png',
                    logoIconUrl: 'https://example.com/logo-icon.png',
                },
            })

            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/flags',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body.THEME.websiteName).toBe(mockPlatform.name)
            expect(body.THEME.colors.primary.default.toLowerCase()).toBe(mockPlatform.primaryColor.toLowerCase())
            expect(body.THEME.logos.fullLogoUrl).toBe(mockPlatform.fullLogoUrl)
            expect(body.THEME.logos.favIconUrl).toBe(mockPlatform.favIconUrl)
            expect(body.THEME.logos.logoIconUrl).toBe(mockPlatform.logoIconUrl)
        })

        it('falls back to the default branding for a field the platform stores as an empty string', async () => {
            await mockAndSaveBasicSetup({
                platform: {
                    name: 'Empty Favicon Co',
                    primaryColor: '#654321',
                    fullLogoUrl: 'https://example.com/full-logo.png',
                    favIconUrl: '',
                    logoIconUrl: 'https://example.com/logo-icon.png',
                },
            })

            const response = await app?.inject({
                method: 'GET',
                url: '/api/v1/flags',
            })

            expect(response?.statusCode).toBe(StatusCodes.OK)
            const body = response?.json()

            expect(body.THEME.websiteName).toBe('Empty Favicon Co')
            expect(body.THEME.logos.favIconUrl).toBe(defaultTheme.logos.favIconUrl)
            expect(body.THEME.logos.fullLogoUrl).toBe('https://example.com/full-logo.png')
        })
    })
})
