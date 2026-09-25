import {
    FlowActionType,
    FlowTriggerType,
    McpServerType,
    ProjectScopedMcpServer,
} from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetOnePopulated = vi.fn()
const mockTranslationList = vi.fn()

vi.mock('../../../../src/app/flows/flow/flow.service', () => ({
    flowService: vi.fn(() => ({
        getOnePopulated: mockGetOnePopulated,
        list: vi.fn().mockResolvedValue({ data: [], next: null, previous: null }),
    })),
}))

vi.mock('../../../../src/app/project/project-service', () => ({
    projectService: vi.fn(() => ({
        getPlatformId: vi.fn().mockResolvedValue('platform-1'),
    })),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: vi.fn(() => ({
        get: vi.fn().mockResolvedValue({ name: '@aiqadam/qadam-data-mapper', version: '0.4.14', actions: {} }),
    })),
}))

vi.mock('../../../../src/app/translation/translation.service', () => ({
    translationService: vi.fn(() => ({
        list: mockTranslationList,
    })),
}))

import { apValidateFlowTool } from '../../../../src/app/mcp/tools/ap-validate-flow'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: 'platform-1' } as unknown as ProjectScopedMcpServer

function flowWithStepInput({ input }: { input: string }): Record<string, unknown> {
    return {
        id: 'flow-1',
        version: {
            displayName: 'Translations Flow',
            trigger: {
                name: 'trigger',
                displayName: 'Trigger',
                valid: true,
                lastUpdatedDate: '2024-01-01T00:00:00Z',
                type: FlowTriggerType.EMPTY,
                settings: {},
                nextAction: {
                    name: 'step_1',
                    displayName: 'Step 1',
                    valid: true,
                    lastUpdatedDate: '2024-01-01T00:00:00Z',
                    type: FlowActionType.PIECE,
                    settings: { qadamName: '@aiqadam/qadam-data-mapper', qadamVersion: '0.4.14', actionName: 'advanced_mapping', input: { text: input }, propertySettings: {} },
                },
            },
        },
    }
}

async function issuesOf(category: string): Promise<string[]> {
    const result = await apValidateFlowTool(mcp, log).execute({ flowId: 'flow-1' })
    const issues = (result.structuredContent as { issues: { category: string, message: string }[] }).issues
    return issues.filter((issue) => issue.category === category).map((issue) => issue.message)
}

describe('ap_validate_flow — translation references', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('flags a literal key that does not exist in the project\'s translations', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithStepInput({ input: '{{$t[\'ghost.key\']}}' }))
        mockTranslationList.mockResolvedValue({ data: [], next: null, previous: null })

        const issues = await issuesOf('translation_key')
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('ghost.key')
    })

    it('warns when a key is missing a locale other keys in the project have', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithStepInput({ input: '{{$t[\'partial.key\']}}' }))
        mockTranslationList.mockResolvedValue({
            data: [
                { id: 't1', key: 'partial.key', values: { en: 'Hello' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' },
                { id: 't2', key: 'other.key', values: { en: 'Other', ru: 'Другое' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' },
            ],
            next: null,
            previous: null,
        })

        const issues = await issuesOf('translation_locale')
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('ru')
    })

    it('says nothing about a key present in every locale used across the project', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithStepInput({ input: '{{$t[\'full.key\']}}' }))
        mockTranslationList.mockResolvedValue({
            data: [
                { id: 't1', key: 'full.key', values: { en: 'Hello', ru: 'Привет' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' },
            ],
            next: null,
            previous: null,
        })

        expect(await issuesOf('translation_key')).toEqual([])
        expect(await issuesOf('translation_locale')).toEqual([])
    })

    it('notes that a dynamic locale is not statically checked', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithStepInput({ input: '{{$t[\'dyn.key\'][trigger[\'output\'].lang]}}' }))
        mockTranslationList.mockResolvedValue({
            data: [
                { id: 't1', key: 'dyn.key', values: { en: 'Hi' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' },
                { id: 't2', key: 'other.key', values: { en: 'Other', ru: 'Другое' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' },
            ],
            next: null,
            previous: null,
        })

        const issues = await issuesOf('translation_locale')
        expect(issues).toHaveLength(1)
        expect(issues[0]).toContain('not statically checked')
    })

    it('does not report an unknown-step error for the $t root', async () => {
        mockGetOnePopulated.mockResolvedValue(flowWithStepInput({ input: '{{$t[\'known.key\']}}' }))
        mockTranslationList.mockResolvedValue({
            data: [{ id: 't1', key: 'known.key', values: { en: 'Hi' }, description: null, projectId: 'project-1', platformId: 'platform-1', created: '', updated: '' }],
            next: null,
            previous: null,
        })

        expect(await issuesOf('template_reference')).toEqual([])
    })
})
