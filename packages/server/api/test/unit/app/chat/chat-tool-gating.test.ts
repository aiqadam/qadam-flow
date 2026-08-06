/**
 * #264. The gate is default-deny, so this file's job is the inverse of the obvious one: it must fail
 * when a tool is *ungated*, and it must not be satisfiable by finding nothing.
 *
 * The first version of this file asserted "no `destructiveHint: true` tool is missing from the gated
 * list". Review pointed out it passed vacuously the moment `annotations` stopped resolving — an empty
 * registry, a renamed field, a factory wrapper, and `filter(destructive)` is empty, so "nothing is
 * missing" is trivially true. Every assertion here is therefore pinned to a counted, named
 * expectation rather than to a filter that can quietly return nothing.
 */
import { McpToolDefinition, ProjectScopedMcpServer } from '@aiqadam/shared'
import { FastifyBaseLogger } from 'fastify'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { chatToolGating } from '../../../../src/app/chat/chat-tool-gating'
import { qadamFlowTools } from '../../../../src/app/mcp/tools'

// Built only to read `title` and `annotations`; no tool is executed, so nothing here touches a
// database or a project.
const fakeMcp = { projectId: 'test-project', platformId: 'test-platform' } as unknown as ProjectScopedMcpServer
const fakeLog = { info: () => undefined, error: () => undefined, warn: () => undefined, debug: () => undefined } as unknown as FastifyBaseLogger

const TOTAL_REGISTERED_TOOLS = 41

// Matches the verb an `operation`-style enum would use to spell a destructive action — this is the
// shape #302 slipped through: `ap_manage_notes` sat in "Additive only" with a plain-looking
// `operation: z.enum([...])` field that happened to contain `DELETE`.
const DESTRUCTIVE_OPERATION_PATTERN = /DELETE|REMOVE|DROP|DESTROY|OVERWRITE/i

function registeredTools(): McpToolDefinition[] {
    return qadamFlowTools(fakeMcp, 'test-user', fakeLog)
}

function registeredTitles(): string[] {
    return registeredTools().map((tool) => tool.title)
}

// Walks every field of a tool's `inputSchema` looking for a Zod enum (directly, or wrapped in
// `.optional()`/`.nullable()`) whose options include a destructive-shaped verb.
function findDestructiveOperationField(tool: McpToolDefinition): string | undefined {
    return Object.entries(tool.inputSchema).find(([, schema]) => {
        const options = enumOptionsOf(schema)
        return options?.some((option) => DESTRUCTIVE_OPERATION_PATTERN.test(option))
    })?.[0]
}

function enumOptionsOf(schema: unknown): string[] | undefined {
    if (schema instanceof z.ZodEnum) {
        return schema.options.filter((option): option is string => typeof option === 'string')
    }
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
        return enumOptionsOf(schema.unwrap())
    }
    return undefined
}

describe('chatToolGating (#264)', () => {
    // The guard against the vacuity above: if the registry stops resolving, this fails first and
    // every assertion below is known to have had something to work with.
    it('sees the whole tool registry', () => {
        expect(registeredTitles().length).toBe(TOTAL_REGISTERED_TOOLS)
    })

    // The point of default-deny. A tool added next month is gated because nobody listed it, and this
    // test is what forces the decision to be made explicitly instead of by omission.
    it('gates every registered tool that is not explicitly listed as ungated', () => {
        const ungated = registeredTitles().filter((title) => !chatToolGating.requiresApproval(title))
        const unexpected = ungated.filter((title) => !chatToolGating.ungatedNames().has(title))

        expect(unexpected, 'a tool is reachable without approval but is not on the ungated list').toEqual([])
        // Counted, so a new tool silently joining the ungated set cannot hide.
        expect(ungated.length, 'the ungated set changed size — was that decision deliberate?').toBe(28)
    })

    it('has no ungated name that does not resolve to a registered tool', () => {
        const titles = new Set(registeredTitles())
        const orphans = [...chatToolGating.ungatedNames()].filter((name) => !titles.has(name))

        expect(orphans, 'an ungated name matches no registered tool — a rename would silently gate it, or a typo silently ungates nothing').toEqual([])
    })

    // Named individually rather than derived, because each of these was found the hard way and a
    // future "tidy-up" that re-derives the set from annotations must break here, loudly.
    it.each([
        ['ap_delete_flow', 'deletes a flow'],
        ['ap_delete_table', 'deletes a table'],
        ['ap_delete_records', 'deletes rows'],
        ['ap_delete_step', 'deletes a step'],
        ['ap_delete_branch', 'deletes a branch'],
        ['ap_run_action', 'executes an action for real, with connections'],
        ['ap_lock_and_publish', 'publishes a flow that then runs against real data; declares destructiveHint: false'],
        ['ap_change_flow_status', 'enables a flow so it starts running; declares destructiveHint: false'],
        ['ap_test_flow', 'executes the whole flow'],
        ['ap_test_step', 'runs EVERY step up to the named one — an ungated ap_add_step plus this reproduces ap_run_action'],
        ['ap_retry_run', 're-executes a PUBLISHED flow against real data; invisible to both annotation hints'],
        ['ap_manage_fields', 'DELETE drops a field and cascades to every cell of that column'],
        ['ap_update_record', 'overwrites cells with no history to restore from'],
    ])('gates %s, which %s', (toolName) => {
        expect(chatToolGating.requiresApproval(toolName)).toBe(true)
    })

    // Fail-closed by construction: an unknown name is gated. Worth pinning, because the whole design
    // rests on it and it is one `!` away from being inverted.
    it('gates a tool it has never heard of', () => {
        expect(chatToolGating.requiresApproval('ap_some_tool_added_next_month')).toBe(true)
        expect(chatToolGating.requiresApproval('')).toBe(true)
    })

    // The flow-building loop has to stay usable, so this is the other half of the trade-off and it
    // deserves to break loudly if someone gates it by accident.
    it('leaves read-only and draft-only tools alone', () => {
        for (const name of ['ap_list_flows', 'ap_flow_structure', 'ap_research_pieces', 'ap_add_step', 'ap_update_step', 'ap_create_flow']) {
            expect(chatToolGating.requiresApproval(name), `${name} must not need approval`).toBe(false)
        }
    })

    // #302. The "additive only" group's whole safety story is "nothing existing is overwritten or
    // destroyed" — a name check can't verify that, only a group *membership* diff can, and that is
    // exactly what let `ap_manage_notes` sit here for a release with `operation: 'DELETE'`. This reads
    // the real input schema of every current member, so a future PR that adds a fourth tool with a
    // DELETE/UPDATE-shaped `operation` enum fails here immediately, without anyone having to notice
    // during review.
    it('additive-only tools have no DELETE/UPDATE-shaped operation field', () => {
        const additiveOnlyTools = registeredTools().filter((tool) => chatToolGating.additiveOnlyNames().has(tool.title))

        expect(additiveOnlyTools.map((tool) => tool.title).sort()).toEqual([...chatToolGating.additiveOnlyNames()].sort())

        for (const tool of additiveOnlyTools) {
            expect(findDestructiveOperationField(tool), `${tool.title} is additive-only but its schema has a destructive-looking field`).toBeUndefined()
        }
    })

    // #302. `ap_manage_notes` supports `operation: 'DELETE'` (verified against its real schema below,
    // so this doesn't just trust the ticket) and stays ungated — but only because notes are canvas
    // annotations inside a draft `flowVersion` that no engine/worker code path ever reads, never
    // because the tool is "additive". It must not be filed under the additive-only group, whose
    // invariant its own DELETE operation would violate.
    it('ap_manage_notes: DELETE is ungated as a canvas annotation, not as additive', () => {
        const notesTool = registeredTools().find((tool) => tool.title === 'ap_manage_notes')
        expect(notesTool, 'ap_manage_notes must still be a registered tool').toBeDefined()

        expect(findDestructiveOperationField(notesTool as McpToolDefinition)).toBe('operation')
        expect(chatToolGating.requiresApproval('ap_manage_notes'), 'ap_manage_notes must not need approval').toBe(false)
        expect(chatToolGating.additiveOnlyNames().has('ap_manage_notes'), 'ap_manage_notes must not be counted as additive-only').toBe(false)
    })
})
