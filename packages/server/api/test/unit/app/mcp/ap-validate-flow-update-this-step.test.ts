import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockListHeld = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()

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
        checkUnavailablePins: async () => [],
    })),
}))

mockListHeld.mockResolvedValue({ data: [], next: null, previous: null })

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer
const HEALTHY_VERSION = '1.3.0'
const DEAD_VERSION = '0.0.1-gone'
const SNAPSHOT_TOOL_VERSION = '1.2.3-main.4'

function flowWithPieceStep({ qadamVersion, exportedUnresolvedPin, agentTools }: {
    qadamVersion: string
    exportedUnresolvedPin?: string
    agentTools?: unknown[]
}): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Update This Step Flow',
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
                        input: { ...(agentTools ? { agentTools } : {}) },
                        propertySettings: {},
                        ...(exportedUnresolvedPin !== undefined ? { exportedUnresolvedPin } : {}),
                    },
                },
            },
        },
    }
}

async function validate({ qadamVersion, exportedUnresolvedPin, agentTools }: {
    qadamVersion: string
    exportedUnresolvedPin?: string
    agentTools?: unknown[]
}): Promise<{ text: string, structuredContent: Record<string, unknown> }> {
    mockGetOnePopulated.mockResolvedValue(flowWithPieceStep({ qadamVersion, exportedUnresolvedPin, agentTools }))
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return {
        text: (result.content?.[0] as { text: string }).text,
        structuredContent: result.structuredContent as Record<string, unknown>,
    }
}

// ADR-0004: `markExportedUnresolved` (`import-flow.ts`) stamps a step's own exact pin onto
// `settings.exportedUnresolvedPin` when an import could not confirm a released equivalent for it,
// for the step itself or one of its agent tools. It names no installation-side fact (the pin may
// well resolve), so like the pre-release note it is informational — reported, never blocking, and
// never counted as a warning or an issue (#808).
describe('ap_validate_flow — update this step note (ADR-0004 import mark, #808)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-email', version: HEALTHY_VERSION })
    })

    it('reports a step whose own pin still matches the import mark as an informational note', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: HEALTHY_VERSION, exportedUnresolvedPin: HEALTHY_VERSION })

        expect(text).toContain('Notes (informational):')
        expect(text).toContain('Imported Pins Without A Confirmed Release:')
        expect(text).toContain('could not be moved to a released version')

        const informational = structuredContent.informational as { category: string, stepName: string, message: string }[]
        expect(informational).toEqual([expect.objectContaining({ category: 'update_this_step', stepName: 'step_1' })])
        expect((structuredContent.issues as { category: string }[]).map(i => i.category)).not.toContain('update_this_step')
        expect((structuredContent.warnings as { category: string }[]).map(i => i.category)).not.toContain('update_this_step')
    })

    it('does not change whether the flow is valid — the note is never a defect', async () => {
        const marked = await validate({ qadamVersion: HEALTHY_VERSION, exportedUnresolvedPin: HEALTHY_VERSION })
        const unmarked = await validate({ qadamVersion: HEALTHY_VERSION })

        expect(marked.structuredContent.valid).toBe(unmarked.structuredContent.valid)
    })

    it('says nothing once the step\'s own pin has moved on and no agent tool is a snapshot', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: HEALTHY_VERSION, exportedUnresolvedPin: DEAD_VERSION })

        expect(text).not.toContain('Imported Pins Without A Confirmed Release:')
        expect(structuredContent.informational).toEqual([])
    })

    it('says nothing for a step that was never stamped', async () => {
        const { text, structuredContent } = await validate({ qadamVersion: HEALTHY_VERSION })

        expect(text).not.toContain('Imported Pins Without A Confirmed Release:')
        expect(structuredContent.informational).toEqual([])
    })

    it('reports the agent-tool wording when the step\'s own pin has moved on but a tool is still a snapshot', async () => {
        const { text } = await validate({
            qadamVersion: HEALTHY_VERSION,
            exportedUnresolvedPin: DEAD_VERSION,
            agentTools: [{ type: 'PIECE', toolName: 'lookup', qadamMetadata: { qadamName: '@aiqadam/qadam-test-tool', qadamVersion: SNAPSHOT_TOOL_VERSION, actionName: 'go' } }],
        })

        expect(text).toContain('Imported Pins Without A Confirmed Release:')
        expect(text).toContain('agent tool pinned to a pre-release build')
    })

    // The tool wording must win when both are true at once: the step's own pin still matches the
    // mark AND a tool is a snapshot.
    it('reports the agent-tool wording even when the step\'s own pin still matches the mark too', async () => {
        const { text } = await validate({
            qadamVersion: HEALTHY_VERSION,
            exportedUnresolvedPin: HEALTHY_VERSION,
            agentTools: [{ type: 'PIECE', toolName: 'lookup', qadamMetadata: { qadamName: '@aiqadam/qadam-test-tool', qadamVersion: SNAPSHOT_TOOL_VERSION, actionName: 'go' } }],
        })

        expect(text).toContain('agent tool pinned to a pre-release build')
    })

    // `getExactVersion` is there precisely so a caret/tilde own pin still matches a bare mark.
    it('reports a step whose own pin is a caret range around the marked exact version', async () => {
        const { text } = await validate({ qadamVersion: `^${HEALTHY_VERSION}`, exportedUnresolvedPin: HEALTHY_VERSION })

        expect(text).toContain('Imported Pins Without A Confirmed Release:')
        expect(text).toContain('could not be moved to a released version')
    })
})
