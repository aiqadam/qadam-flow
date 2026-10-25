import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()
const mockListHeld = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: mockGetPlatformId,
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: mockGet,
        getMany: async ({ pins }: { pins: { name: string, version: string }[] }) => new Map(await Promise.all(pins.map(async (pin) => {
            const metadata = await mockGet({ name: pin.name, version: pin.version })
            return [`${pin.name}@${pin.version}`, metadata ? { status: 'found', metadata } : { status: 'missing' }] as const
        }))),
        resolveVersions: async ({ pins }: { pins: { name: string, version: string }[] }) => new Map(await Promise.all(pins.map(async (pin) => {
            const metadata = await mockGet({ name: pin.name, version: pin.version })
            return [`${pin.name}@${pin.version}`, metadata ? { status: 'resolved', version: metadata.version } : { status: 'missing' }] as const
        }))),
    })),
}))

vi.mock('../../../../src/app/qadams/pin-moves/qadam-pin-move.service', () => ({
    qadamPinMoveService: vi.fn(() => ({
        listHeld: mockListHeld,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer
const SNAPSHOT_VERSION = '1.3.0-main.412'
const RELEASE_VERSION = '1.3.0'

function flowWithPieceStep({ qadamVersion }: { qadamVersion: string }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Held Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Send Email',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: '@aiqadam/qadam-test-email',
                        qadamVersion,
                        actionName: 'send_email',
                        input: {},
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

function heldMove({ overrides }: { overrides?: Record<string, unknown> } = {}): Record<string, unknown> {
    return {
        id: 'move-1',
        flowId: 'flow-1',
        flowVersionId: 'version-1',
        stepName: 'step_1',
        qadamName: '@aiqadam/qadam-test-email',
        fromVersion: SNAPSHOT_VERSION,
        toVersion: '1.3.0-main.500',
        cause: 'SNAPSHOT_FOLLOW',
        status: 'REVERTED',
        revertedAt: '2026-10-10T12:00:00.000Z',
        ...overrides,
    }
}

async function validate({ qadamVersion }: { qadamVersion: string }): Promise<{ text: string, structuredContent: Record<string, unknown> }> {
    mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion }))
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return {
        text: (result.content?.[0] as { text: string }).text,
        structuredContent: result.structuredContent as Record<string, unknown>,
    }
}

// ADR-0004 "Following `main`" (#854): a reverted move holds the step, so the snapshot follow pass
// will not move it again until its version changes. Like the pre-release note this is a fact, not a
// fault — it is informational, never blocks publishing, and never counts as a warning or an issue.
describe('ap_validate_flow — snapshot follow hold (ADR-0004, #854)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: SNAPSHOT_VERSION })
        mockListHeld.mockResolvedValue({ data: [heldMove()], next: null, previous: null })
    })

    it('reports a held step as an informational note, not an issue or a warning', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: SNAPSHOT_VERSION })

        expect(text).toContain('Notes (informational):')
        expect(text).toContain('Held Snapshot Follow Steps:')
        expect(text).toContain('is held at')

        const informational = structuredContent.informational as { category: string, stepName: string, message: string }[]
        expect(informational).toContainEqual(expect.objectContaining({ category: 'follow_hold', stepName: 'step_1' }))
        expect((structuredContent.issues as { category: string }[]).map(i => i.category)).not.toContain('follow_hold')
        expect((structuredContent.warnings as { category: string }[]).map(i => i.category)).not.toContain('follow_hold')
        expect(mockListHeld).toHaveBeenCalledWith({ flowId: 'flow-1', projectId: 'project-1', platformId: 'platform-1' })
    })

    it('does not change whether the flow is valid — the note is never a defect', async () => {
        const held = await validate({ qadamVersion: SNAPSHOT_VERSION })
        mockListHeld.mockResolvedValue({ data: [], next: null, previous: null })
        const notHeld = await validate({ qadamVersion: SNAPSHOT_VERSION })

        expect(held.structuredContent.valid).toBe(notHeld.structuredContent.valid)
    })

    it('matches a caret-prefixed pin by its exact version', async () => {
        const { structuredContent } = await validate({ qadamVersion: `~${SNAPSHOT_VERSION}` })

        expect((structuredContent.informational as { category: string }[]).map(i => i.category)).toContain('follow_hold')
    })

    it('says nothing when the step version changed after the revert', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: RELEASE_VERSION })

        expect(text).not.toContain('Held Snapshot Follow Steps:')
        expect(structuredContent.informational).toEqual([])
    })

    it('says nothing when the hold read fails, and still validates the flow', async () => {
        mockListHeld.mockRejectedValue(new Error('connection terminated unexpectedly'))

        const { text, structuredContent } = await validate({ qadamVersion: SNAPSHOT_VERSION })

        expect(text).not.toContain('Held Snapshot Follow Steps:')
        expect((structuredContent.informational as { category: string }[]).map(i => i.category)).not.toContain('follow_hold')
        expect(log.warn).toHaveBeenCalled()
    })
})
