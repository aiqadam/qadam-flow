import { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Unit rather than integration: the claim under test — the exact installed-qadam count reaching
// the model — depends only on `buildSystemPrompt`'s own interpolation, not on a real provider
// round-trip. Mocking `qadamMetadataService`, `chatProjects` and `system` keeps the assertion on
// that interpolation alone; the prompt template itself is read for real (`vitest.config.ts`
// chdir's to the repo root, which is what `SYSTEM_PROMPT_PATH` is relative to), so a future edit
// to the template's wording is exercised too.
// `vi.mock` factories are hoisted above these declarations, so the mocks they close over must be
// created through `vi.hoisted` — a plain `const` here would be a TDZ read at mock-eval time.
const { list, findAccessible, systemGet } = vi.hoisted(() => ({
    list: vi.fn(),
    findAccessible: vi.fn(),
    systemGet: vi.fn(),
}))

vi.mock('../../../../src/app/qadams/metadata/qadam-metadata-service', () => ({
    qadamMetadataService: () => ({ list: (...args: unknown[]) => list(...args) }),
}))
vi.mock('../../../../src/app/chat/chat-projects', () => ({
    chatProjects: { findAccessible: (...args: unknown[]) => findAccessible(...args) },
}))
// `chat-agent.service.ts` pulls this in transitively (via the MCP tool set), and its module body
// resolves `@aiqadam/qadam-telegram-bot` through a real dynamic `import()`. Vite's import-analysis
// walks that expression at transform time regardless of whether the branch ever runs, so a sandbox
// without every one of the 238 qadam packages installed fails to even load this file — unrelated
// to anything `buildSystemPrompt` exercises. Stubbed with the same shape so nothing downstream of
// this import breaks either.
vi.mock('../../../../src/app/trigger/long-polling/event-puller-registry', () => ({
    eventPullerRegistry: {
        load: vi.fn(),
        isRegistered: vi.fn().mockReturnValue(false),
        registeredQadamNames: vi.fn().mockReturnValue([]),
        getOrLoad: vi.fn(),
        qadamNames: vi.fn().mockReturnValue([]),
        get: vi.fn(),
    },
}))
// Same reason, reached instead through the MCP tool set chat wires up: `chat-tools.ts` and
// `mcp-service.ts` both statically import every qadam this sandbox's `bun install` symlinked but
// never built a `dist/` for. None of that machinery runs inside `buildSystemPrompt`.
vi.mock('../../../../src/app/mcp/tools', () => ({
    LOCKED_TOOL_NAMES: [],
    qadamFlowTools: [],
}))
vi.mock('../../../../src/app/mcp/mcp-service', () => ({
    mcpServerService: () => ({ getByProjectId: vi.fn() }),
}))
vi.mock('../../../../src/app/helper/system/system', async (importOriginal) => {
    // Partial mock, not a full replacement: the real module is pulled in transitively by other
    // things `chat-agent.service.ts` imports (auth, Redis config) which call `system.getOrThrow`
    // and friends — replacing the whole module would break those unrelated call sites.
    const actual = await importOriginal<typeof import('../../../../src/app/helper/system/system')>()
    return {
        ...actual,
        system: { ...actual.system, get: (...args: unknown[]) => systemGet(...args) },
    }
})

import { buildSystemPrompt } from '../../../../src/app/chat/chat-agent.service'

const log = { error: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger

function qadams(count: number): { name: string }[] {
    return Array.from({ length: count }, (_unused, index) => ({ name: `qadam_${index}` }))
}

beforeEach(() => {
    vi.clearAllMocks()
    findAccessible.mockResolvedValue({ id: 'project_1', displayName: 'My Project' })
    systemGet.mockReturnValue('https://app.example.com')
})

describe('buildSystemPrompt', () => {
    // Every case below uses its own platformId. `installedQadamCount` caches by platformId with a
    // TTL (see chat-agent.service.ts) so that a chat turn does not re-scan `qadam_metadata` on
    // every message — sharing one platformId across cases here would read the first case's cached
    // count instead of exercising each case's own mocked `list()` result.

    // The bug this pins: the prompt used to hardcode "400+ app integrations" regardless of what
    // was actually installed. The count must now be the real, per-platform/project number.
    it('reports the actual installed qadam count instead of the fabricated "400+" claim', async () => {
        list.mockResolvedValue(qadams(7))

        const prompt = await buildSystemPrompt({ projectId: 'project_1', platformId: 'platform_count_7', userId: 'user_1', log })

        expect(prompt).toContain('across 7 app integrations')
        expect(prompt).not.toContain('400+')
        expect(list).toHaveBeenCalledWith({ projectId: 'project_1', platformId: 'platform_count_7', includeHidden: false })
    })

    // Decision made on the ticket: exact integer, no "+" suffix — the point is to stop overselling
    // the catalogue, so the number must read plainly even when it's small.
    it('never appends a "+" to the count — the number is exact, not an estimate', async () => {
        list.mockResolvedValue(qadams(2))

        const prompt = await buildSystemPrompt({ projectId: 'project_1', platformId: 'platform_count_2', userId: 'user_1', log })

        expect(prompt).toContain('across 2 app integrations')
        expect(prompt).not.toContain('2+ app integrations')
    })

    it('leaves no unresolved {{INTEGRATION_COUNT}} placeholder in the compiled prompt', async () => {
        list.mockResolvedValue(qadams(42))

        const prompt = await buildSystemPrompt({ projectId: 'project_1', platformId: 'platform_count_42', userId: 'user_1', log })

        expect(prompt).not.toContain('{{INTEGRATION_COUNT}}')
    })

    // Pins the fix for the perf finding code-quality review raised: an uncached `list()` call sat
    // on the critical path of every chat turn (a full scan-and-hydrate of `qadam_metadata`, on
    // every message send and every tool-approval resume). A second call for the same platform
    // within the TTL must be a cache hit, not a second `list()` call.
    it('caches the count per platform so a second prompt build in the same window skips list()', async () => {
        list.mockResolvedValue(qadams(11))
        const platformId = 'platform_cache_hit'

        await buildSystemPrompt({ projectId: 'project_1', platformId, userId: 'user_1', log })
        list.mockClear()
        const second = await buildSystemPrompt({ projectId: 'project_1', platformId, userId: 'user_1', log })

        expect(second).toContain('across 11 app integrations')
        expect(list).not.toHaveBeenCalled()
    })

    it('does not serve one platform a different platform\'s cached count', async () => {
        list.mockResolvedValue(qadams(3))
        await buildSystemPrompt({ projectId: 'project_1', platformId: 'platform_a', userId: 'user_1', log })

        list.mockResolvedValue(qadams(99))
        const prompt = await buildSystemPrompt({ projectId: 'project_1', platformId: 'platform_b', userId: 'user_1', log })

        expect(prompt).toContain('across 99 app integrations')
    })
})
