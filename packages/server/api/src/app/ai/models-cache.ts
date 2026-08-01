import { AIProviderModel, isNil } from '@aiqadam/shared'

// A plain Map cleared once a day is a memory ceiling set by whoever writes to it most. The key
// carries the provider row's `updated` timestamp, so every edit mints a fresh entry and the
// previous one is never read again — a loop of edit-then-list grew the map without bound until
// midnight. A Map iterates in insertion order, so re-inserting on read makes eviction of the
// first key an LRU eviction, in the only two operations this cache has.
const MAX_ENTRIES = 200

const entries = new Map<string, AIProviderModel[]>()

function get(key: string): AIProviderModel[] | undefined {
    const cached = entries.get(key)
    if (isNil(cached)) {
        return undefined
    }
    entries.delete(key)
    entries.set(key, cached)
    return cached
}

function set({ key, models }: { key: string, models: AIProviderModel[] }): void {
    entries.delete(key)
    entries.set(key, models)
    while (entries.size > MAX_ENTRIES) {
        const oldestKey = entries.keys().next().value
        if (isNil(oldestKey)) {
            return
        }
        entries.delete(oldestKey)
    }
}

function clear(): void {
    entries.clear()
}

function size(): number {
    return entries.size
}

export const modelsCache = { get, set, clear, size }
export const MODELS_CACHE_MAX_ENTRIES = MAX_ENTRIES
