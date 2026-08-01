import { AIProviderModelType } from '@aiqadam/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { MODELS_CACHE_MAX_ENTRIES, modelsCache } from '../../../../src/app/ai/models-cache'

const models = (id: string) => [{ id, name: id, type: AIProviderModelType.TEXT }]

const fill = (count: number, prefix = 'key') => {
    for (let index = 0; index < count; index++) {
        modelsCache.set({ key: `${prefix}-${index}`, models: models(`${prefix}-${index}`) })
    }
}

describe('AI provider models cache', () => {
    afterEach(() => {
        modelsCache.clear()
    })

    it('never grows past its bound', () => {
        // The cache key carries the provider row's `updated` timestamp, so a loop of
        // edit-then-list mints a brand-new key every time and never reuses one. Before the bound
        // this map only shrank at midnight.
        fill(MODELS_CACHE_MAX_ENTRIES * 3)

        expect(modelsCache.size()).toBe(MODELS_CACHE_MAX_ENTRIES)
    })

    it('evicts the least recently used entry, not the most recent one', () => {
        fill(MODELS_CACHE_MAX_ENTRIES)

        modelsCache.set({ key: 'one-too-many', models: models('one-too-many') })

        expect(modelsCache.get('key-0')).toBeUndefined()
        expect(modelsCache.get('key-1')).toEqual(models('key-1'))
        expect(modelsCache.get('one-too-many')).toEqual(models('one-too-many'))
    })

    it('treats a read as a use, so a hot entry survives a full turnover', () => {
        fill(MODELS_CACHE_MAX_ENTRIES)

        // Without the re-insert on read this entry is the oldest and is the first thing evicted.
        expect(modelsCache.get('key-0')).toEqual(models('key-0'))
        fill(MODELS_CACHE_MAX_ENTRIES - 1, 'later')

        expect(modelsCache.get('key-0')).toEqual(models('key-0'))
        expect(modelsCache.get('key-1')).toBeUndefined()
    })

    it('replaces rather than duplicates when the same key is written twice', () => {
        modelsCache.set({ key: 'same', models: models('first') })
        modelsCache.set({ key: 'same', models: models('second') })

        expect(modelsCache.size()).toBe(1)
        expect(modelsCache.get('same')).toEqual(models('second'))
    })

    it('treats a rewrite as a use, so a refreshed entry is not the next one evicted', () => {
        fill(MODELS_CACHE_MAX_ENTRIES)

        // `Map.set` on a key it already holds keeps that key's original insertion position, so
        // without the delete-then-set in `set()` the oldest entry stays the oldest however often
        // it is rewritten — and eviction order stops tracking use. Size and value alone cannot
        // see that: a plain `Map.set` gives both.
        modelsCache.set({ key: 'key-0', models: models('key-0-refreshed') })
        modelsCache.set({ key: 'one-too-many', models: models('one-too-many') })

        expect(modelsCache.get('key-0')).toEqual(models('key-0-refreshed'))
        expect(modelsCache.get('key-1')).toBeUndefined()
    })

    it('is emptied by clear(), which is what the daily cron calls', () => {
        fill(10)

        modelsCache.clear()

        expect(modelsCache.size()).toBe(0)
    })
})
