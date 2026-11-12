import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()
const mockListHeld = vi.fn()
const mockCheckPinStays = vi.fn()

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
        checkUnavailablePins: mockCheckPinStays,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer
const PINNED_VERSION = '1.3.0'

function flowWithPieceStep(): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            id: 'version-1',
            displayName: 'Unavailable Flow',
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
                        qadamVersion: PINNED_VERSION,
                        actionName: 'send_email',
                        input: {},
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

function pinStay({ overrides }: { overrides?: Record<string, unknown> } = {}): Record<string, unknown> {
    return {
        stepName: 'step_1',
        qadamName: '@aiqadam/qadam-test-email',
        version: PINNED_VERSION,
        reason: 'outside-caret',
        detail: 'the image\'s version is outside the pin\'s caret range',
        ...overrides,
    }
}

async function validate(flow: Record<string, unknown> = flowWithPieceStep()): Promise<{ text: string, structuredContent: Record<string, unknown> }> {
    mockGetOnePopulated.mockResolvedValue(flow)
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return {
        text: (result.content?.[0] as { text: string }).text,
        structuredContent: result.structuredContent as Record<string, unknown>,
    }
}

// ADR-0003 "Unavailable version" / "Versions that were never published" (#808): a step whose pin
// is unavailable and was not moved to the image's build is reported as a warning — it calls for
// action but never disables the flow (#435) and never blocks publishing.
describe('ap_validate_flow — version unavailable, update this step (ADR-0003, #808)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: PINNED_VERSION })
        mockListHeld.mockResolvedValue({ data: [], next: null, previous: null })
        mockCheckPinStays.mockResolvedValue([pinStay()])
    })

    it('reports the step as a warning with its reason', async () => {
        const { text, structuredContent } = await validate()

        expect(text).toContain('Version Unavailable — Update This Step:')
        expect(text).toContain('is pinned to a version that is unavailable')

        const warnings = structuredContent.warnings as { category: string, stepName: string, message: string, severity: string }[]
        expect(warnings).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
        expect((structuredContent.warnings as { category: string }[]).length).toBe(1)
    })

    it('reports the step once, under version_unavailable rather than the generic qadam_version', async () => {
        mockGet.mockResolvedValue(undefined)

        const { structuredContent } = await validate()

        const categories = (structuredContent.warnings as { category: string }[]).map((issue) => issue.category)
        expect(categories).toContain('version_unavailable')
        expect(categories).not.toContain('qadam_version')
    })

    it('keeps an unavailable agent-tool pin reported when that step is also marked', async () => {
        const flow = flowWithPieceStep()
        const action = (flow.version as { trigger: { nextAction: { settings: Record<string, unknown> } } }).trigger.nextAction
        action.settings.input = {
            agentTools: [{ type: 'PIECE', toolName: 'lookup', qadamMetadata: { qadamName: '@aiqadam/qadam-test-tool', qadamVersion: '0.0.1', actionName: 'go' } }],
        }
        mockGet.mockResolvedValue(undefined)

        const { structuredContent } = await validate(flow)

        const warnings = structuredContent.warnings as { category: string, stepName: string }[]
        const issues = structuredContent.issues as { category: string, stepName: string, message: string }[]
        expect(warnings).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
        expect(issues).toContainEqual(expect.objectContaining({
            category: 'qadam_version',
            stepName: 'step_1',
            message: expect.stringContaining('has an agent tool'),
        }))
    })

    it('reads the mark for the flow version and the caller\'s project', async () => {
        await validate()

        expect(mockCheckPinStays).toHaveBeenCalledWith({ flowId: 'flow-1', flowVersionId: 'version-1', projectId: 'project-1', platformId: 'platform-1' })
    })

    it('says nothing when the step is not marked', async () => {
        mockCheckPinStays.mockResolvedValue([])

        const { text, structuredContent } = await validate()

        expect(text).not.toContain('Version Unavailable — Update This Step:')
        expect((structuredContent.warnings as { category: string }[]).map(i => i.category)).not.toContain('version_unavailable')
    })

    it('drops the warning but still validates the flow when the read fails', async () => {
        mockCheckPinStays.mockRejectedValue(new Error('connection terminated unexpectedly'))

        const { text, structuredContent } = await validate()

        expect(text).not.toContain('Version Unavailable — Update This Step:')
        expect((structuredContent.warnings as { category: string }[]).map(i => i.category)).not.toContain('version_unavailable')
        expect(structuredContent.issues).toBeDefined()
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ flowId: 'flow-1' }),
            '[apValidateFlow] Unavailable-pin check failed; the report omits the version-unavailable warning',
        )
    })
})
