import { DefaultProjectRole, ErrorCode } from '@aiqadam/shared'
import { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { createMemberContext, createTestContext, TestContext } from '../../../helpers/test-context'
import { setupTestEnvironment, teardownTestEnvironment } from '../../../helpers/test-setup'

let app: FastifyInstance | null = null
let ctx: TestContext

beforeAll(async () => {
    app = await setupTestEnvironment()
})

afterAll(async () => {
    await teardownTestEnvironment()
})

beforeEach(async () => {
    ctx = await createTestContext(app!)
})

describe('GET /v1/trigger-runs/status', () => {
    // A platform MEMBER holding the *widest* project role there is. If even this principal is
    // refused, so is a VIEWER — and a test built on VIEWER could not tell "platform-admin is
    // required" from "some project permission is required".
    const platformMember = () => createMemberContext(app!, ctx, { projectRole: DefaultProjectRole.ADMIN })

    it('should refuse a platform member who is not a platform admin', async () => {
        const member = await platformMember()

        const response = await member.get('/v1/trigger-runs/status')

        expect(response?.statusCode).toBe(StatusCodes.FORBIDDEN)
        expect(response?.json().code).toBe(ErrorCode.AUTHORIZATION)
    })

    it('should still let a platform admin read the report', async () => {
        const response = await ctx.get('/v1/trigger-runs/status')

        expect(response?.statusCode).toBe(StatusCodes.OK)
        expect(response?.json()).toEqual({ pieces: {} })
    })
})
