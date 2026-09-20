import { FlowActionType, FlowTriggerType, Step } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockRegistry = vi.fn()

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: (): { get: typeof mockGet, registry: typeof mockRegistry } => ({ get: mockGet, registry: mockRegistry }),
}))

import { qadamPinUtil } from '../../../../src/app/qadams/metadata/qadam-pin-util'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger
const PLATFORM_ID = 'platform-1'

function pieceStep({ name, qadamName, qadamVersion, skip }: {
    name: string
    qadamName?: string
    qadamVersion?: string
    skip?: boolean
}): Step {
    return {
        name,
        displayName: name,
        valid: true,
        type: FlowActionType.PIECE,
        ...(skip ? { skip: true } : {}),
        settings: {
            qadamName,
            qadamVersion,
            actionName: 'doThing',
            input: {},
        },
    } as unknown as Step
}

function triggerStep({ qadamName, qadamVersion }: { qadamName: string, qadamVersion: string }): Step {
    return {
        name: 'trigger',
        displayName: 'Select Trigger',
        valid: true,
        type: FlowTriggerType.PIECE,
        settings: {
            qadamName,
            qadamVersion,
            triggerName: 'onEvent',
            input: {},
        },
    } as unknown as Step
}

describe('qadamPinUtil.splitPin', () => {
    it('splits a plain, unscoped name on its single "@"', () => {
        expect(qadamPinUtil.splitPin({ pin: '@aiqadam/qadam-slack@0.2.0' })).toEqual({ name: '@aiqadam/qadam-slack', version: '0.2.0' })
    })

    // Scoped names carry their own leading `@aiqadam/`, so the split must use the LAST `@`, not
    // the first — splitting on the first would cut the name in half.
    it('splits a scoped qadam name on the LAST "@", not the first', () => {
        expect(qadamPinUtil.splitPin({ pin: '@acme/qadam-internal@1.2.3' })).toEqual({ name: '@acme/qadam-internal', version: '1.2.3' })
    })

    // Not reachable through any caller today (every one feeds this `pinOf`'s own output), but this
    // is an exported util, and `lastIndexOf` returning -1 must not silently drop the last character
    // of `name` into nowhere via `slice(0, -1)`.
    it('does not corrupt the name when the pin carries no "@" at all', () => {
        expect(qadamPinUtil.splitPin({ pin: 'not-a-pin' })).toEqual({ name: 'not-a-pin', version: '' })
    })
})

describe('qadamPinUtil.pinOf / collectDistinctPins', () => {
    it('formats a pin as name@version', () => {
        const step = pieceStep({ name: 'step_1', qadamName: '@aiqadam/qadam-slack', qadamVersion: '0.2.0' })
        expect(qadamPinUtil.pinOf({ step: qadamPinUtil.getQadamSteps({ trigger: step })[0] })).toBe('@aiqadam/qadam-slack@0.2.0')
    })

    it('dedupes identical pins across multiple steps', () => {
        const first = pieceStep({ name: 'step_1', qadamName: '@aiqadam/qadam-slack', qadamVersion: '0.2.0' })
        const second = pieceStep({ name: 'step_2', qadamName: '@aiqadam/qadam-slack', qadamVersion: '0.2.0' })
        const steps = [...qadamPinUtil.getQadamSteps({ trigger: first }), ...qadamPinUtil.getQadamSteps({ trigger: second })]

        expect(qadamPinUtil.collectDistinctPins({ steps })).toEqual(['@aiqadam/qadam-slack@0.2.0'])
    })
})

describe('qadamPinUtil.getQadamSteps', () => {
    it('includes a skipped step — a dead pin on a skipped step still fails provisioning', () => {
        const step = pieceStep({ name: 'step_1', qadamName: '@aiqadam/qadam-slack', qadamVersion: '0.2.0', skip: true })

        expect(qadamPinUtil.getQadamSteps({ trigger: step }).map(s => s.name)).toEqual(['step_1'])
    })

    it('excludes a piece step missing qadamName or qadamVersion', () => {
        const step = pieceStep({ name: 'step_1', qadamName: undefined, qadamVersion: undefined })

        expect(qadamPinUtil.getQadamSteps({ trigger: step })).toEqual([])
    })

    it('includes a PIECE trigger with a pin', () => {
        const trigger = triggerStep({ qadamName: '@aiqadam/qadam-webhook', qadamVersion: '0.1.0' })

        expect(qadamPinUtil.getQadamSteps({ trigger }).map(s => s.name)).toEqual(['trigger'])
    })
})

describe('qadamPinUtil.resolvePinVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns the resolved version when the pin resolves', async () => {
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-slack', version: '0.2.0' })

        const version = await qadamPinUtil.resolvePinVersion({ name: '@aiqadam/qadam-slack', version: '0.2.0', platformId: PLATFORM_ID, log })

        expect(version).toBe('0.2.0')
    })

    it('returns undefined on a definite miss', async () => {
        mockGet.mockResolvedValue(undefined)

        const version = await qadamPinUtil.resolvePinVersion({ name: '@aiqadam/qadam-slack', version: '0.0.1-gone', platformId: PLATFORM_ID, log })

        expect(version).toBeUndefined()
    })

    it('propagates a thrown error rather than swallowing it — this is the raw primitive callers wrap themselves', async () => {
        mockGet.mockRejectedValue(new Error('ECONNRESET'))

        await expect(qadamPinUtil.resolvePinVersion({ name: '@aiqadam/qadam-slack', version: '0.2.0', platformId: PLATFORM_ID, log }))
            .rejects.toThrow('ECONNRESET')
    })
})

describe('qadamPinUtil.resolvePins — tri-state', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('reports true for a resolved pin', async () => {
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-slack', version: '0.2.0' })

        const resolutions = await qadamPinUtil.resolvePins({ pins: ['@aiqadam/qadam-slack@0.2.0'], platformId: PLATFORM_ID, log })

        expect(resolutions.get('@aiqadam/qadam-slack@0.2.0')).toBe(true)
    })

    it('reports false for a definite miss', async () => {
        mockGet.mockResolvedValue(undefined)

        const resolutions = await qadamPinUtil.resolvePins({ pins: ['@aiqadam/qadam-slack@0.0.1-gone'], platformId: PLATFORM_ID, log })

        expect(resolutions.get('@aiqadam/qadam-slack@0.0.1-gone')).toBe(false)
    })

    // The blocking distinction: a lookup that errors must read as "unknown", never as "false" —
    // a caller that persists a rewrite on `false` (the heal migration) must not do so on a
    // transient failure. See `qadam-pin-util.ts` for why this cannot just collapse to `false`.
    it('reports undefined, not false, when the lookup throws', async () => {
        mockGet.mockRejectedValue(new Error('ECONNRESET'))

        const resolutions = await qadamPinUtil.resolvePins({ pins: ['@aiqadam/qadam-slack@0.2.0'], platformId: PLATFORM_ID, log })

        expect(resolutions.get('@aiqadam/qadam-slack@0.2.0')).toBeUndefined()
        expect(resolutions.has('@aiqadam/qadam-slack@0.2.0')).toBe(true)
    })
})

describe('qadamPinUtil.findResolvableVersion', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('picks the highest version when the registry lists several for the same name, not the first entry', async () => {
        mockRegistry.mockResolvedValue([
            { name: '@acme/qadam-internal', version: '1.0.0' },
            { name: '@acme/qadam-internal', version: '3.0.0' },
            { name: '@acme/qadam-internal', version: '2.0.0' },
            { name: '@aiqadam/qadam-slack', version: '0.9.0' },
        ])

        const version = await qadamPinUtil.findResolvableVersion({ name: '@acme/qadam-internal', platformId: PLATFORM_ID, log })

        expect(version).toBe('3.0.0')
    })

    it('returns undefined when the registry has no entry for the name', async () => {
        mockRegistry.mockResolvedValue([{ name: '@aiqadam/qadam-slack', version: '0.9.0' }])

        const version = await qadamPinUtil.findResolvableVersion({ name: '@acme/qadam-internal', platformId: PLATFORM_ID, log })

        expect(version).toBeUndefined()
    })

    it('returns undefined, not a throw, when the registry lookup fails', async () => {
        mockRegistry.mockRejectedValue(new Error('registry unreachable'))

        const version = await qadamPinUtil.findResolvableVersion({ name: '@acme/qadam-internal', platformId: PLATFORM_ID, log })

        expect(version).toBeUndefined()
    })
})
