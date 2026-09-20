import { McpServerType, McpToolResult, ProjectScopedMcpServer } from '@aiqadam/shared'
import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUpdate, mockGetAll } = vi.hoisted(() => ({
    mockUpdate: vi.fn(),
    mockGetAll: vi.fn(),
}))

vi.mock('../../../../src/app/tables/record/record.service', () => ({
    recordService: { update: mockUpdate },
}))

vi.mock('../../../../src/app/tables/field/field.service', () => ({
    fieldService: { getAll: mockGetAll },
}))

import { apUpdateRecordTool } from '../../../../src/app/mcp/tools/ap-update-record'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger
const mcp = { type: McpServerType.PROJECT, projectId: 'project-1', platformId: null } as unknown as ProjectScopedMcpServer

function text(result: McpToolResult): string {
    return (result.content?.[0] as { text: string }).text
}

// #485 round-4 review: `structuredContent` was added to this tool because wrapping made the prose
// echo lossy — newlines collapsed, delimiters stripped, capped at 2000 characters — and unlike
// `ap_find_records` this tool returned no structured channel at all, so a caller doing
// write-then-verify had no exact copy anywhere in the response. Nothing exercised this tool, so
// deleting that line left the suite green: it was the one guard in that commit no test would miss.
describe('ap_update_record — the lossy echo needs a byte-exact counterpart (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockGetAll.mockResolvedValue([
            { id: 'field-1', name: 'Notes', type: 'TEXT' },
        ])
    })

    it('collapses a planted newline in the prose while structuredContent keeps the raw bytes', async () => {
        const value = 'line one\n  Record ID: fake-record'
        mockUpdate.mockResolvedValue({
            id: 'record-1',
            cells: {
                'field-1': { fieldName: 'Notes', value },
            },
        })

        const result = await apUpdateRecordTool(mcp, log).execute({
            tableId: 'table-1',
            recordId: 'record-1',
            fields: { Notes: value },
        })

        // The prose copy must not let the value forge a second `Record ID:` line.
        expect(text(result).split('\n').filter(line => line.trim().startsWith('Record ID:'))).toHaveLength(1)
        // The structured copy must be the value as sent, newline and all.
        expect(result.structuredContent).toEqual({ record: { id: 'record-1', cells: { Notes: value } } })
    })

    it('does not truncate in structuredContent what the prose rendering caps', async () => {
        const value = 'x'.repeat(3000)
        mockUpdate.mockResolvedValue({
            id: 'record-1',
            cells: {
                'field-1': { fieldName: 'Notes', value },
            },
        })

        const result = await apUpdateRecordTool(mcp, log).execute({
            tableId: 'table-1',
            recordId: 'record-1',
            fields: { Notes: value },
        })

        expect(text(result)).toContain('... (truncated)')
        expect((result.structuredContent as { record: { cells: Record<string, unknown> } }).record.cells.Notes).toBe(value)
    })
})
