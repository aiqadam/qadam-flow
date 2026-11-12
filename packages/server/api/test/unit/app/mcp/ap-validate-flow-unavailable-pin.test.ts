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
// `checkUnavailablePins` reports as a stay. `checkUnavailablePins` resolves a pin exact-match only
// (`isPinAvailable`), stricter than `qadam_version`'s own check (`resolvePins`, which also accepts
// the image's bundled build as a stand-in inside the pin's caret range) — so a step can be marked
// here while still resolving, and still running, under the generic check (`reverted-by-user` is
// the clearest case: someone deliberately kept it there). Only a step `qadam_version` ALSO confirms
// missing keeps its (error) severity here; every other stay is a warning. ADR-0003's "the flow is
// never disabled" (#435) is about the REST publish gate, not this report.
describe('ap_validate_flow — version unavailable, update this step (ADR-0003, #808)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: PINNED_VERSION })
        mockListHeld.mockResolvedValue({ data: [], next: null, previous: null })
        mockCheckPinStays.mockResolvedValue([pinStay()])
    })

    it('reports a resolvable but held step as a warning, not a blocking issue', async () => {
        mockCheckPinStays.mockResolvedValue([pinStay({ overrides: { reason: 'reverted-by-user', detail: 'a person reverted a move of this step' } })])

        const { text, structuredContent } = await validate()

        expect(text).toContain('Version Unavailable — Update This Step:')
        expect(text).toContain('is pinned to a version that is unavailable')
        expect(text).not.toContain('delete and re-add')

        // The fixture's EMPTY trigger is structurally invalid on its own (step_validity, unrelated
        // to this pin), so `valid` alone cannot isolate this issue's severity — the category's
        // placement in `warnings`, never `issues`, is what proves it does not block.
        const warnings = structuredContent.warnings as { category: string, stepName: string, message: string }[]
        const issues = structuredContent.issues as { category: string }[]
        expect(warnings).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
        expect(issues.map(i => i.category)).not.toContain('version_unavailable')
    })

    // #474, regression: `checkUnavailablePins` (`isPinAvailable`, per-pin) and `qadam_version`
    // (`resolvePins`, one batched `resolveVersions` call) are two independent reads. A held step
    // whose `resolveVersions` call fails transiently must not inherit the destructive remedy —
    // only a `qadam_version` lookup that actually CONFIRMS a pin missing (not one that merely
    // errored) may ever suggest deleting and re-adding the step.
    it('does not advise a destructive edit for a held step when the generic lookup merely errored', async () => {
        mockGet.mockRejectedValue(new Error('ECONNRESET'))
        mockCheckPinStays.mockResolvedValue([pinStay({ overrides: { reason: 'reverted-by-user', detail: 'a person reverted a move of this step' } })])

        const { text, structuredContent } = await validate()

        expect(text).not.toContain('delete and re-add')
        expect(text).toContain('Re-run before acting')

        const warnings = structuredContent.warnings as { category: string, stepName: string }[]
        expect(warnings).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
    })

    it('reports a confirmed-missing step as a blocking issue, with the working remedy', async () => {
        mockGet.mockResolvedValue(undefined)

        const { text, structuredContent } = await validate()

        expect(text).toContain('delete and re-add the step')
        expect(structuredContent.valid).toBe(false)

        const issues = structuredContent.issues as { category: string, stepName: string, message: string }[]
        expect(issues).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
        expect((structuredContent.warnings as unknown[]).length).toBe(0)
    })

    it('reports the step once, under version_unavailable rather than the generic qadam_version, and still blocks publishing', async () => {
        mockGet.mockResolvedValue(undefined)

        const { structuredContent } = await validate()

        const categories = (structuredContent.issues as { category: string }[]).map((issue) => issue.category)
        expect(categories).toContain('version_unavailable')
        expect(categories).not.toContain('qadam_version')
        expect(structuredContent.valid).toBe(false)
    })

    it('keeps an unavailable agent-tool pin reported when that step is also marked', async () => {
        const flow = flowWithPieceStep()
        const action = (flow.version as { trigger: { nextAction: { settings: Record<string, unknown> } } }).trigger.nextAction
        action.settings.input = {
            agentTools: [{ type: 'PIECE', toolName: 'lookup', qadamMetadata: { qadamName: '@aiqadam/qadam-test-tool', qadamVersion: '0.0.1', actionName: 'go' } }],
        }
        mockGet.mockResolvedValue(undefined)

        const { structuredContent } = await validate(flow)

        const issues = structuredContent.issues as { category: string, stepName: string, message: string }[]
        expect(issues).toContainEqual(expect.objectContaining({ category: 'version_unavailable', stepName: 'step_1' }))
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
        expect((structuredContent.issues as { category: string }[]).map(i => i.category)).not.toContain('version_unavailable')
    })

    it('drops the mark but still validates the flow when the read fails', async () => {
        mockCheckPinStays.mockRejectedValue(new Error('connection terminated unexpectedly'))

        const { text, structuredContent } = await validate()

        expect(text).not.toContain('Version Unavailable — Update This Step:')
        expect((structuredContent.issues as { category: string }[]).map(i => i.category)).not.toContain('version_unavailable')
        expect(structuredContent.issues).toBeDefined()
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ flowId: 'flow-1' }),
            '[apValidateFlow] Unavailable-pin check failed; the report omits the version-unavailable mark',
        )
    })
})
