import { PrincipalType, WorkerPrincipal } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { accessTokenManager } from '../../../../src/app/authentication/lib/access-token-manager'
import { jwtUtils } from '../../../../src/app/helper/jwt-utils'

const SECRET = 'generate-worker-token-test-secret'

const mockLog: FastifyBaseLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
} as unknown as FastifyBaseLogger

const manager = accessTokenManager(mockLog)

beforeAll(() => {
    vi.spyOn(jwtUtils, 'getJwtSecret').mockResolvedValue(SECRET)
})

describe('generateWorkerToken', () => {
    it('binds the worker group into the token when one is given', async () => {
        const token = await manager.generateWorkerToken({ workerGroupId: 'group-a' })

        const principal = await manager.verifyPrincipal(token)

        expect(principal.type).toBe(PrincipalType.WORKER)
        expect(principal).toMatchObject({ workerGroupId: 'group-a' })
    })

    it('mints no workerGroupId claim when no group is given', async () => {
        const token = await manager.generateWorkerToken()

        const decoded = await jwtUtils.decodeAndVerify<WorkerPrincipal>({ jwt: token, key: SECRET })

        expect(decoded.type).toBe(PrincipalType.WORKER)
        expect('workerGroupId' in decoded).toBe(false)
    })

    it('resolves a legacy token that predates the claim to an undefined group', async () => {
        const legacyToken = await jwtUtils.sign({
            payload: { id: 'legacy-worker', type: PrincipalType.WORKER },
            key: SECRET,
            expiresInSeconds: 3600,
        })

        const principal = await manager.verifyPrincipal(legacyToken)

        expect(principal.type).toBe(PrincipalType.WORKER)
        expect(principal.type === PrincipalType.WORKER && principal.workerGroupId).toBeUndefined()
    })
})
