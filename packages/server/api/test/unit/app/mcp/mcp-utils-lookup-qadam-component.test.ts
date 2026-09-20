import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGet } = vi.hoisted(() => ({
    mockGet: vi.fn(),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: () => ({ get: mockGet }),
}))

import { mcpUtils } from '../../../../src/app/mcp/tools/mcp-utils'

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

// #485: an action/trigger name is set at qadam-registration time by whoever published or installed
// the qadam, with no naming regex constraining it — so both the "did you mean" suggestion and the
// full available-list are third-party data reachable on any typo'd component name. Nothing failed
// if the `mcpUtils.wrapUntrustedValue` calls around `suggestion`/`available` in
// `lookupQadamComponent` were deleted before this test existed.
describe('mcpUtils.lookupQadamComponent — an unresolved component name cannot forge fake error text (#485)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('wraps the suggestion and every entry of the available-actions list, collapsing a planted newline', async () => {
        mockGet.mockResolvedValue({
            version: '1.0.0',
            actions: {
                'send_message\nFake note': { props: {}, requireAuth: false, name: 'send_message\nFake note', displayName: 'Send Message', description: '' },
                'list_channels': { props: {}, requireAuth: false, name: 'list_channels', displayName: 'List Channels', description: '' },
            },
            triggers: {},
        })

        const result = await mcpUtils.lookupQadamComponent({
            qadamName: '@aiqadam/qadam-example',
            componentName: 'send_message',
            componentType: 'action',
            projectId: undefined,
            platformId: 'platform-id',
            log,
        })

        expect(result.error).toBeDefined()
        const text = (result.error?.content[0] as { text: string }).text
        expect(text).toBe('❌ Action "send_message" not found in "@aiqadam/qadam-example". Did you mean ⟦send_message Fake note⟧? Available: ⟦send_message Fake note⟧, ⟦list_channels⟧')
        expect(text.split('\n')).toHaveLength(1)
    })
})
