import { apDayjs } from '@aiqadam/server-utils'
import { isNil, MachineInformation, parseToJsonIfPossible } from '@aiqadam/shared'
import { redisConnections } from '../../database/redis-connections'

const REDIS_KEY_PREFIX = 'workerMachines:'

const workerMachineKey = (workerId: string): string => `${REDIS_KEY_PREFIX}${workerId}`

function isWorkerMachine(value: unknown): value is WorkerMachine {
    return typeof value === 'object'
        && value !== null
        && 'id' in value
        && typeof value.id === 'string'
        && 'information' in value
        && !isNil(value.information)
}

function parseWorkerMachine(raw: string | null): WorkerMachine | null {
    if (isNil(raw)) {
        return null
    }
    const parsed = parseToJsonIfPossible(raw)
    return isWorkerMachine(parsed) ? parsed : null
}

async function readWorkerMachine(workerId: string): Promise<WorkerMachine | null> {
    const redisConnection = await redisConnections.useExisting()
    return parseWorkerMachine(await redisConnection.get(workerMachineKey(workerId)))
}

export const workerMachineCache = () => ({

    // Deliberately an index set rather than `SCAN MATCH 'workerMachines:*'`. SCAN walks the whole
    // keyspace whatever the pattern, and this Redis is shared with BullMQ — the workers page
    // refetches every 5s (workers-hooks.ts:16), so on a busy install that is hundreds of
    // round-trips per second against the job queue. The index costs one SREM per expired worker.
    async find(): Promise<WorkerMachine[]> {
        const redisConnection = await redisConnections.useExisting()

        const ids = await redisConnection.smembers(WORKER_MACHINE_INDEX_KEY)
        if (ids.length === 0) {
            return []
        }
        const values = await redisConnection.mget(ids.map(workerMachineKey))
        // A key expires on its own but its index entry does not, so a null slot is the normal way
        // an expired worker surfaces. Dropping the id here is what keeps the index from growing.
        const expired = ids.filter((_id, index) => isNil(values[index]))
        if (expired.length > 0) {
            await redisConnection.srem(WORKER_MACHINE_INDEX_KEY, ...expired)
        }
        return values
            .map(parseWorkerMachine)
            .filter((worker): worker is WorkerMachine => !isNil(worker))
    },

    async findOne(workerId: string): Promise<WorkerMachine | null> {
        return readWorkerMachine(workerId)
    },

    async delete(ids: string[]): Promise<void> {
        const redisConnection = await redisConnections.useExisting()

        if (ids.length > 0) {
            await redisConnection.del(...ids.map(workerMachineKey))
            await redisConnection.srem(WORKER_MACHINE_INDEX_KEY, ...ids)
        }
    },

    // Every write re-arms the TTL, so Redis itself drops a worker that stops checking in.
    // That is what makes an unreachable worker stop being reported without anything having to
    // run: the previous prune lived in `machineService.list`, so it only happened when a human
    // opened the workers page, and a per-process timer would only be correct on whichever API
    // instance happened to own it.
    async upsert(worker: UpsertWorkerMachineParams): Promise<void> {
        const redisConnection = await redisConnections.useExisting()

        const now = apDayjs().toISOString()
        const existing = await readWorkerMachine(worker.id)
        const value: WorkerMachine = isNil(existing)
            ? { ...worker, created: now, updated: now }
            : { ...existing, ...worker, updated: now }

        await redisConnection.set(workerMachineKey(worker.id), JSON.stringify(value), 'EX', WORKER_MACHINE_TTL_SECONDS)
        await redisConnection.sadd(WORKER_MACHINE_INDEX_KEY, worker.id)
    },
})

// Matches the freshness window the workers page used to apply when it pruned by hand, so an
// operator sees the same "gone after a minute of silence" behaviour, just without the page view.
export const WORKER_MACHINE_TTL_SECONDS = 60

// Deliberately outside the `workerMachines:<id>` namespace: a worker whose id was literally
// "index" would otherwise collide with this set.
export const WORKER_MACHINE_INDEX_KEY = 'workerMachines-index'

export type WorkerMachine = {
    id: string
    updated: string
    created: string
    information: MachineInformation
    type?: 'SHARED' | 'DEDICATED'
    workerGroupId?: string
}

export type UpsertWorkerMachineParams = {
    id: string
    information: MachineInformation
    type?: 'SHARED' | 'DEDICATED'
    workerGroupId?: string
}
