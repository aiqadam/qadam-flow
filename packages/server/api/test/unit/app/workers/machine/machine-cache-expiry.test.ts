import { MachineInformation } from '@aiqadam/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Redis with the two behaviours this test is about: a per-key TTL, and a clock we can
// move. Everything else (MGET and the index set) is only here so `workerMachineCache` can run
// against it. The set commands deliberately have no TTL of their own — that asymmetry is the
// point of the index, and modelling it is what lets the test show the index being pruned.
const { fakeRedisState } = vi.hoisted(() => {
    const store = new Map<string, { value: string, expiresAtMs: number | null }>()
    const sets = new Map<string, Set<string>>()
    const clock = { nowMs: 0 }

    const readAlive = (key: string) => {
        const entry = store.get(key)
        if (!entry) {
            return undefined
        }
        if (entry.expiresAtMs !== null && entry.expiresAtMs <= clock.nowMs) {
            store.delete(key)
            return undefined
        }
        return entry
    }

    const connection = {
        async set(key: string, value: string, mode?: string, ttlInSeconds?: number) {
            const expiresAtMs = mode === 'EX' && typeof ttlInSeconds === 'number'
                ? clock.nowMs + ttlInSeconds * 1000
                : null
            store.set(key, { value, expiresAtMs })
            return 'OK'
        },
        async get(key: string) {
            return readAlive(key)?.value ?? null
        },
        async mget(...args: (string | string[])[]) {
            return args.flat().map((key) => readAlive(key)?.value ?? null)
        },
        async del(...keys: string[]) {
            return keys.filter((key) => store.delete(key)).length
        },
        async sadd(key: string, ...members: string[]) {
            const set = sets.get(key) ?? new Set<string>()
            members.forEach((member) => set.add(member))
            sets.set(key, set)
            return members.length
        },
        async srem(key: string, ...members: string[]) {
            const set = sets.get(key)
            return members.filter((member) => set?.delete(member)).length
        },
        async smembers(key: string) {
            return Array.from(sets.get(key) ?? [])
        },
    }

    return { fakeRedisState: { connection, clock, store, sets } }
})

vi.mock('../../../../../src/app/database/redis-connections', () => ({
    redisConnections: {
        useExisting: async () => fakeRedisState.connection,
    },
}))

import { WAITER_TIMEOUT_MS } from '../../../../../src/app/workers/job-queue/queue-dispatcher'
import { WORKER_MACHINE_INDEX_KEY, WORKER_MACHINE_TTL_SECONDS, workerMachineCache } from '../../../../../src/app/workers/machine/machine-cache'

function fakeMachineInfo(workerId: string): MachineInformation {
    return {
        workerId,
        cpuUsagePercentage: 0,
        ramUsagePercentage: 0,
        totalAvailableRamInBytes: 0,
        totalCpuCores: 1,
        ip: '127.0.0.1',
        diskInfo: { total: 100, free: 50, used: 50, percentage: 50 },
        workerProps: { version: '1.1.0' },
        sandboxes: [],
    }
}

describe('worker registry expiry — #222', () => {
    beforeEach(() => {
        fakeRedisState.store.clear()
        fakeRedisState.clock.nowMs = 0
    })

    // The point of the test: nothing in it calls `machineService.list`, opens a page, or runs a
    // timer. If the registry stops expiring on its own, a removed worker is reported forever.
    it('stops reporting a worker that stops checking in, with nothing pruning it', async () => {
        await workerMachineCache().upsert({
            id: 'worker-1',
            information: fakeMachineInfo('worker-1'),
            type: 'SHARED',
        })

        expect(await workerMachineCache().find()).toHaveLength(1)

        fakeRedisState.clock.nowMs += (WORKER_MACHINE_TTL_SECONDS + 1) * 1000

        expect(await workerMachineCache().find()).toEqual([])
        expect(await workerMachineCache().findOne('worker-1')).toBeNull()
    })

    it('keeps reporting a worker that is still checking in', async () => {
        await workerMachineCache().upsert({
            id: 'worker-1',
            information: fakeMachineInfo('worker-1'),
            type: 'SHARED',
        })

        fakeRedisState.clock.nowMs += (WORKER_MACHINE_TTL_SECONDS - 10) * 1000
        await workerMachineCache().upsert({
            id: 'worker-1',
            information: fakeMachineInfo('worker-1'),
            type: 'SHARED',
        })
        fakeRedisState.clock.nowMs += (WORKER_MACHINE_TTL_SECONDS - 10) * 1000

        const workers = await workerMachineCache().find()
        expect(workers.map((worker) => worker.id)).toEqual(['worker-1'])
    })

    it('preserves the creation stamp across check-ins', async () => {
        await workerMachineCache().upsert({
            id: 'worker-1',
            information: fakeMachineInfo('worker-1'),
        })
        const created = (await workerMachineCache().findOne('worker-1'))?.created

        await workerMachineCache().upsert({
            id: 'worker-1',
            information: fakeMachineInfo('worker-1'),
        })

        expect((await workerMachineCache().findOne('worker-1'))?.created).toBe(created)
    })
})

// The index exists so `find` never has to SCAN a keyspace shared with BullMQ. That only holds if
// it is pruned: a key expires on its own, its index entry does not. Without the SREM in `find`
// this set grows by one per worker that ever existed, and every later `find` does an MGET over
// ids that are all null — the cost the index was added to avoid, plus unbounded memory.
describe('worker registry index — #222', () => {
    it('drops an expired worker from the index rather than accumulating dead ids', async () => {
        const cache = workerMachineCache()
        await cache.upsert({ id: 'worker-gone', information: fakeMachineInfo('worker-gone') })
        await cache.upsert({ id: 'worker-alive', information: fakeMachineInfo('worker-alive') })

        fakeRedisState.clock.nowMs += (WORKER_MACHINE_TTL_SECONDS + 1) * 1000
        await cache.upsert({ id: 'worker-alive', information: fakeMachineInfo('worker-alive') })

        expect((await cache.find()).map((worker) => worker.id)).toEqual(['worker-alive'])
        expect(Array.from(fakeRedisState.sets.get(WORKER_MACHINE_INDEX_KEY) ?? [])).toEqual(['worker-alive'])
    })

    it('drops an explicitly deleted worker from the index', async () => {
        const cache = workerMachineCache()
        await cache.upsert({ id: 'worker-bye', information: fakeMachineInfo('worker-bye') })

        expect(fakeRedisState.sets.get(WORKER_MACHINE_INDEX_KEY)?.has('worker-bye')).toBe(true)

        await cache.delete(['worker-bye'])

        expect(fakeRedisState.sets.get(WORKER_MACHINE_INDEX_KEY)?.has('worker-bye')).toBe(false)
        // Not just unindexed — the payload has to go too, or a disconnected worker's JSON sits in
        // Redis for the rest of its TTL. Dropping the DEL leaves the index assertion above green.
        expect(await cache.findOne('worker-bye')).toBeNull()
    })
})

// The TTL is not a free parameter. An idle healthy worker only re-registers when its long poll
// returns, and that poll is WAITER_TIMEOUT_MS long — so a TTL below it expires workers that are
// perfectly alive, and the page an operator checks during an incident goes empty. Nothing tied
// the two constants together before, and the tests above derive their clock advance from the TTL
// itself, so they stay green for any value. These do not.
describe('worker registry TTL is coupled to the poll it has to outlive — #222', () => {
    it('outlives a full long-poll, with margin', () => {
        expect(WORKER_MACHINE_TTL_SECONDS * 1000).toBeGreaterThan(WAITER_TIMEOUT_MS)
    })

    it('is the 60s window the workers page has always shown', () => {
        expect(WORKER_MACHINE_TTL_SECONDS).toBe(60)
    })
})
