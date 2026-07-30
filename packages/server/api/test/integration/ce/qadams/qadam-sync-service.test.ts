import {
    PackageType,
    QadamType,
} from '@aiqadam/shared'
import { FastifyBaseLogger, FastifyInstance } from 'fastify'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { qadamMetadataService } from '../../../../src/app/qadams/metadata/qadam-metadata-service'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'


let app: FastifyInstance | null = null
let mockLog: FastifyBaseLogger

beforeAll(async () => {
    app = await setupTestEnvironment()
    mockLog = app!.log!
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    await databaseConnection().getRepository('qadam_metadata').createQueryBuilder().delete().execute()
})

describe('Piece Metadata Create', () => {
    it('should insert a piece via create', async () => {
        const service = qadamMetadataService(mockLog)

        await service.create({
            qadamMetadata: {
                name: 'piece-a',
                displayName: 'Piece A',
                description: 'Piece A description',
                version: '1.0.0',
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '9.9.9',
                actions: {},
                triggers: {},
                authors: [],
                logoUrl: 'https://example.com/logo.png',
                contextInfo: undefined,
            },
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
            publishCacheRefresh: false,
        })

        const repo = databaseConnection().getRepository('qadam_metadata')
        const allPieces = await repo.find()
        expect(allPieces).toHaveLength(1)
        expect(allPieces[0].name).toBe('piece-a')
    })

    it('should reject duplicate piece creation', async () => {
        const service = qadamMetadataService(mockLog)

        await service.create({
            qadamMetadata: {
                name: 'piece-dup',
                displayName: 'Piece Dup',
                description: 'Piece Dup description',
                version: '1.0.0',
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '9.9.9',
                actions: {},
                triggers: {},
                authors: [],
                logoUrl: 'https://example.com/logo.png',
                contextInfo: undefined,
            },
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
            publishCacheRefresh: false,
        })

        await expect(service.create({
            qadamMetadata: {
                name: 'piece-dup',
                displayName: 'Piece Dup',
                description: 'Piece Dup description',
                version: '1.0.0',
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '9.9.9',
                actions: {},
                triggers: {},
                authors: [],
                logoUrl: 'https://example.com/logo.png',
                contextInfo: undefined,
            },
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
            publishCacheRefresh: false,
        })).rejects.toThrow()
    })

    it('should bulk delete pieces', async () => {
        const service = qadamMetadataService(mockLog)

        await service.create({
            qadamMetadata: {
                name: 'delete-me',
                displayName: 'Delete Me',
                description: 'Delete Me description',
                version: '1.0.0',
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '9.9.9',
                actions: {},
                triggers: {},
                authors: [],
                logoUrl: 'https://example.com/logo.png',
                contextInfo: undefined,
            },
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
            publishCacheRefresh: false,
        })

        await service.create({
            qadamMetadata: {
                name: 'keep-me',
                displayName: 'Keep Me',
                description: 'Keep Me description',
                version: '1.0.0',
                minimumSupportedRelease: '0.0.0',
                maximumSupportedRelease: '9.9.9',
                actions: {},
                triggers: {},
                authors: [],
                logoUrl: 'https://example.com/logo.png',
                contextInfo: undefined,
            },
            packageType: PackageType.REGISTRY,
            qadamType: QadamType.OFFICIAL,
            publishCacheRefresh: false,
        })

        await service.bulkDelete([{ name: 'delete-me', version: '1.0.0' }])

        const repo = databaseConnection().getRepository('qadam_metadata')
        const allPieces = await repo.find()
        expect(allPieces).toHaveLength(1)
        expect(allPieces[0].name).toBe('keep-me')
    })
})
