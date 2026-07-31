/**
 * #264. This file exists to fail when the gated list and the tool registry drift apart, which is
 * the failure mode a human introduces months from now: add a destructive tool, forget the list, and
 * nothing complains — the gate fails *open* and every other test still passes.
 *
 * The second assertion matters as much as the first: a typo or a rename in the list resolves to no
 * tool at all, which also fails open and is invisible at runtime.
 */
import { ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { chatToolGating } from '../../../../src/app/chat/chat-tool-gating'
import { qadamFlowTools } from '../../../../src/app/mcp/tools'

// The registry is built purely to read `title` and `annotations` off each definition; no tool is
// executed, so a bare object is enough and nothing here touches a database or a project.
const fakeMcp = { projectId: 'test-project', platformId: 'test-platform' } as unknown as ProjectScopedMcpServer
const fakeLog = { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger

function registeredTools(): { title: string, destructive: boolean, openWorld: boolean }[] {
    return qadamFlowTools(fakeMcp, 'test-user', fakeLog).map((tool) => ({
        title: tool.title,
        destructive: tool.annotations?.destructiveHint === true,
        openWorld: tool.annotations?.openWorldHint === true,
    }))
}

describe('chatToolGating (#264)', () => {
    it('gates every tool that declares itself destructive', () => {
        const missing = registeredTools()
            .filter((tool) => tool.destructive)
            .map((tool) => tool.title)
            .filter((title) => !chatToolGating.requiresApproval(title))

        expect(
            missing,
            'a tool declares `destructiveHint: true` but is not in the gated list — the model can run it unattended. Add it to GATED_TOOL_NAMES in chat-tool-gating.ts.',
        ).toEqual([])
    })

    // A name in the list that matches no registered tool gates nothing at all, and does so silently.
    it('has no gated name that does not resolve to a registered tool', () => {
        const titles = new Set(registeredTools().map((tool) => tool.title))
        const orphans = [...chatToolGating.names()].filter((name) => !titles.has(name))

        expect(
            orphans,
            'a gated name matches no registered tool — likely a typo or a renamed tool, which makes the gate fail open',
        ).toEqual([])
    })

    // These three are the reason the list is explicit instead of derived. If someone later "tidies
    // up" by switching to `destructiveHint || openWorldHint`, this is the test that stops them, and
    // the message is written to explain why rather than just to fail.
    it.each([
        ['ap_lock_and_publish', 'publishes a flow that then runs against real data, yet declares destructiveHint: false'],
        ['ap_change_flow_status', 'enables a flow so it starts running for real, yet declares destructiveHint: false'],
        ['ap_test_flow', 'executes the whole flow; openWorldHint is true but destructiveHint is false'],
    ])('gates %s, which the annotations alone would miss: %s', (toolName) => {
        expect(chatToolGating.requiresApproval(toolName)).toBe(true)
    })

    // Recorded as a deliberate exclusion, not an oversight: gating the model's normal
    // build-and-check step would put a prompt between it and every step it configures.
    it('does not gate ap_test_step, deliberately', () => {
        expect(chatToolGating.requiresApproval('ap_test_step')).toBe(false)
    })
})
