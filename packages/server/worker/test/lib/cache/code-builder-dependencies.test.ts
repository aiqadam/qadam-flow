import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionMode, FlowVersionState } from '@aiqadam/shared'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Only the `bun` process is replaced: its failure reaches code-builder through the real bunRunner,
// exactly as spawnWithKill words it.
let spawnFailure: Error
let tempDir: string

beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'code-builder-deps-test-')))
    vi.resetModules()
    vi.doMock('../../../src/lib/config/worker-settings', () => ({
        workerSettings: { getSettings: () => ({ EXECUTION_MODE: ExecutionMode.UNSANDBOXED }) },
    }))
    vi.doMock('../../../src/lib/utils/exec', () => ({
        spawnWithKill: async () => {
            throw spawnFailure
        },
    }))
})

afterEach(async () => {
    vi.doUnmock('../../../src/lib/config/worker-settings')
    vi.doUnmock('../../../src/lib/utils/exec')
    await rm(tempDir, { recursive: true, force: true })
})

describe('codeBuilder dependency install (#584)', () => {
    it('turns a dependency bun cannot resolve into an UnresolvableDependencyError', async () => {
        spawnFailure = new Error('Exit 1\nstdout: bun install v1.3.14\nstderr: error: No version matching "99.99.99" found for specifier "lodash" (but package exists)\nerror: lodash@99.99.99 failed to resolve')
        const { UnresolvableDependencyError } = await import('../../../src/lib/cache/code/unresolvable-dependency-error')

        const error: unknown = await processStep().then(() => undefined, (e: unknown) => e)

        expect(error).toBeInstanceOf(UnresolvableDependencyError)
        expect(error).toHaveProperty('cause', spawnFailure)
    })

    it('rethrows an unreachable registry unchanged, so the run stays retryable', async () => {
        spawnFailure = new Error('Exit 1\nstdout: bun install v1.3.14\nstderr: error: ConnectionRefused downloading package manifest lodash\nerror: lodash@4.17.21 failed to resolve')

        await expect(processStep()).rejects.toBe(spawnFailure)
    })
})

async function processStep(): Promise<void> {
    const { codeBuilder } = await import('../../../src/lib/cache/code/code-builder')
    await codeBuilder(pino({ level: 'silent' })).processCodeStep({
        artifact: {
            name: 'step_1',
            flowVersionId: 'flow-version-1',
            flowVersionState: FlowVersionState.LOCKED,
            sourceCode: { code: 'export const code = async () => 1', packageJson: '{"dependencies":{"lodash":"99.99.99"}}' },
        },
        codesFolderPath: join(tempDir, 'codes'),
    })
}
