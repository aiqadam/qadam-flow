/**
 * #350: "A cross-project request — must refuse. The assistant already claims it only sees the
 * current project; that claim should be tested rather than trusted, since it is a tenant-isolation
 * statement." This file is that test.
 *
 * The claim rests on three independent facts, each pinned below because any one of them failing
 * quietly reopens a cross-project channel:
 *
 * 1. `ap_set_project_context` — the one MCP tool that lets a caller *name* a project — is
 *    registered only for the standalone MCP server (`mcp-server-builder.ts`), never wired into
 *    chat's own tool set (`qadamFlowTools` via `chat-tools.ts`).
 * 2. No other registered tool's input schema declares a `projectId` field. Every real project
 *    reference inside a tool's `execute` reads the server-closed-over `mcp.projectId`
 *    (`ProjectScopedMcpServer`, set once in `chat-agent.service.ts` from the conversation's own
 *    pinned project), never anything from the model's own arguments — verified for every tool file
 *    under `mcp/tools/`, `ap-set-project-context.ts` being the sole exception.
 * 3. Even if a model tries to smuggle a `projectId` into a tool call anyway, `chatToolInput.lenient`
 *    validates the call against the tool's own strict Zod shape before it reaches `execute`
 *    (`chat-tools.ts`'s `toAiSdkTool`), and plain `z.object()` silently drops unknown keys — so the
 *    smuggled value never reaches the tool, whether or not the schema happens to mention it.
 */
import { McpToolDefinition, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { chatToolInput } from '../../../../src/app/chat/chat-tool-input'
import { qadamFlowTools } from '../../../../src/app/mcp/tools'

// Built only to read tool metadata and run schema validation; no tool is executed, so nothing
// here touches a database or a real project.
const fakeMcp = { projectId: 'the-only-project-this-chat-can-see', platformId: 'test-platform' } as unknown as ProjectScopedMcpServer
const fakeLog = { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger

function registeredTools(): McpToolDefinition[] {
    return qadamFlowTools(fakeMcp, 'test-user', fakeLog)
}

describe('chat tenant isolation (#350)', () => {
    // The one tool that could name a different project is a standalone-MCP-only tool. If a future
    // change wires it into chat's registry — directly, or via a refactor that merges the two tool
    // lists — this is what catches it.
    it('never registers ap_set_project_context for chat', () => {
        const titles = registeredTools().map((tool) => tool.title)
        expect(titles).not.toContain('ap_set_project_context')
    })

    // Guards the two checks below against the same vacuity `chat-tool-gating.test.ts` calls out:
    // if the registry stops resolving (an import breaks, a factory throws and is swallowed
    // upstream), an empty array satisfies "no tool has X" for any X. Same count
    // `chat-tool-gating.test.ts` pins for the same reason — keep the two in sync.
    it('sees the whole tool registry', () => {
        expect(registeredTools().length).toBe(51)
    })

    it('no registered tool declares a projectId input field', () => {
        const toolsWithProjectIdField = registeredTools()
            .filter((tool) => Object.keys(tool.inputSchema).includes('projectId'))
            .map((tool) => tool.title)

        expect(toolsWithProjectIdField, 'a tool exposing projectId as input would let a caller name a different project').toEqual([])
    })

    // Belt-and-braces over fact 2 above: even a tool that *did* declare a projectId field would
    // still not leak one, because `chatToolInput.lenient` (the wrapper every chat tool goes through
    // in `chat-tools.ts`) validates against the tool's own strict shape, and `z.object()` drops any
    // key that shape does not declare.
    it('silently strips a smuggled projectId before it would reach a tool\'s execute', async () => {
        const listFlows = registeredTools().find((tool) => tool.title === 'ap_list_flows')
        expect(listFlows, 'ap_list_flows must still be a registered tool').toBeDefined()

        const { validate } = chatToolInput.lenient((listFlows as McpToolDefinition).inputSchema)
        if (validate === undefined) {
            throw new Error('chatToolInput.lenient must expose a validate function')
        }
        const result = await validate({ limit: 5, projectId: 'someone-elses-project' })

        expect(result.success).toBe(true)
        if (result.success) {
            expect(result.value).not.toHaveProperty('projectId')
            expect(result.value).toEqual({ limit: 5 })
        }
    })
})
