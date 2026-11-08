import { FlowActionType, FlowTriggerType, McpServerType, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockGetPlatformId = vi.fn()
const mockGet = vi.fn()
const mockUnsupportedPins = vi.fn()

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

vi.mock('../../../../src/app/qadams/census/framework-census-marking', () => ({
    frameworkCensusMarking: vi.fn(() => ({
        unsupportedPins: mockUnsupportedPins,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer
const HEALTHY_VERSION = '0.2.0'

function flowWithAgentTool({ qadamVersion }: { qadamVersion: string }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Framework Version Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Select Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Research Agent',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.PIECE,
                    settings: {
                        qadamName: '@aiqadam/qadam-test-email',
                        qadamVersion: HEALTHY_VERSION,
                        actionName: 'send_email',
                        input: {
                            agentTools: [{ type: 'PIECE', toolName: 'lookup', qadamMetadata: { qadamName: '@aiqadam/qadam-test-tool', qadamVersion, actionName: 'go' } }],
                        },
                        propertySettings: {},
                    },
                },
            },
        },
    }
}

async function validate(): Promise<string> {
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    return (result.content?.[0] as { text: string }).text
}

// #779: the worker provisions an agent tool the same way it provisions a step, so a tool pinned
// to a qadam built against a retired framework context version fails the same way a step does —
// `ap_validate_flow`'s framework-version check must cover both.
describe('ap_validate_flow — framework version mark for agent tools (#779)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetPlatformId.mockResolvedValue('platform-1')
        mockGet.mockResolvedValue({ name: '@aiqadam/qadam-test-tool', version: HEALTHY_VERSION })
    })

    it('flags an agent tool whose pin needs a retired framework context version', async () => {
        const toolPin = `@aiqadam/qadam-test-tool@${HEALTHY_VERSION}`
        mockUnsupportedPins.mockResolvedValue(new Map([[toolPin, { source: 'official', frameworkMajor: 0, contextVersion: '1', status: 'unsupported' }]]))
        mockGetOnePopulated.mockResolvedValue(flowWithAgentTool({ qadamVersion: HEALTHY_VERSION }))

        const text = await validate()

        expect(text).toContain('Unsupported Framework Versions')
        expect(text).toContain('has an agent tool')
        expect(text).toContain('lookup')
        expect(text).toContain('framework version no longer supported')
    })

    it('says nothing when no context version has been retired', async () => {
        mockUnsupportedPins.mockResolvedValue(new Map())
        mockGetOnePopulated.mockResolvedValue(flowWithAgentTool({ qadamVersion: HEALTHY_VERSION }))

        const text = await validate()

        expect(text).not.toContain('Unsupported Framework Versions')
    })
})
