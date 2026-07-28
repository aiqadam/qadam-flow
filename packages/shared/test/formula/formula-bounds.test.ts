import { describe, expect, it } from 'vitest'
import { exceedsSizeBudget } from '../../src/lib/formula/formula-bounds'

describe('exceedsSizeBudget', () => {
    it('accepts a string exactly at maxSize', () =>
        expect(exceedsSizeBudget({ value: 'a'.repeat(100), maxSize: 100 })).toBe(false))

    it('rejects a string one over maxSize', () =>
        expect(exceedsSizeBudget({ value: 'a'.repeat(101), maxSize: 100 })).toBe(true))

    // Elements/values are zero-cost strings here so the total charged is
    // exactly the container's own length/key-count — isolating that part of
    // the accounting from the recursive cost of what it contains.
    it('accepts an array exactly at maxSize', () =>
        expect(exceedsSizeBudget({ value: Array.from({ length: 100 }, () => ''), maxSize: 100 })).toBe(false))

    it('rejects an array one over maxSize', () =>
        expect(exceedsSizeBudget({ value: Array.from({ length: 101 }, () => ''), maxSize: 100 })).toBe(true))

    it('accepts an object exactly at maxSize (one unit per own key)', () => {
        const obj: Record<string, string> = {}
        for (let i = 0; i < 100; i++) obj[`k${i}`] = ''
        expect(exceedsSizeBudget({ value: obj, maxSize: 100 })).toBe(false)
    })

    it('rejects an object one key over maxSize', () => {
        const obj: Record<string, string> = {}
        for (let i = 0; i < 101; i++) obj[`k${i}`] = ''
        expect(exceedsSizeBudget({ value: obj, maxSize: 100 })).toBe(true)
    })

    it('terminates on a self-referencing object instead of looping forever', () => {
        const cyclic: Record<string, unknown> = { name: 'a' }
        cyclic.self = cyclic
        // Every revisit of `cyclic` costs 2 units (its 2 own keys: name, self),
        // so a maxSize of 10 is exhausted within a handful of visits — this
        // assertion is really "the call returns at all, and quickly".
        const start = Date.now()
        expect(exceedsSizeBudget({ value: cyclic, maxSize: 10 })).toBe(true)
        expect(Date.now() - start).toBeLessThan(1000)
    })

    it('terminates on a self-referencing array instead of looping forever', () => {
        const cyclic: unknown[] = ['a']
        cyclic.push(cyclic)
        const start = Date.now()
        expect(exceedsSizeBudget({ value: cyclic, maxSize: 10 })).toBe(true)
        expect(Date.now() - start).toBeLessThan(1000)
    })

    it('array early-abort is real: a huge oversized array is rejected in well under the time a full walk of its elements would take', () => {
        const hugeArray = Array.from({ length: 3_000_000 }, (_, i) => i)
        const start = performance.now()
        const exceeds = exceedsSizeBudget({ value: hugeArray, maxSize: 100 })
        const elapsed = performance.now() - start
        expect(exceeds).toBe(true)
        // `.length` is O(1), so rejecting a 3,000,000-element array against a
        // maxSize of 100 must not cost anywhere near what visiting all 3
        // million elements would (that takes hundreds of ms in this suite's
        // environment) — a generous 50ms still catches a regression back to
        // "push everything, then check".
        expect(elapsed).toBeLessThan(50)
    })

    it('a within-budget nested structure (arrays of small objects) is accepted', () => {
        const value = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }))
        expect(exceedsSizeBudget({ value, maxSize: 100_000 })).toBe(false)
    })

    it('an over-budget nested structure is rejected', () => {
        const value = Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `item-${i}` }))
        expect(exceedsSizeBudget({ value, maxSize: 1000 })).toBe(true)
    })
})
