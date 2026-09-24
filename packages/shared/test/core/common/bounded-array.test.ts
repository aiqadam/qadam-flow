import { z } from 'zod'
import { BoundedArray } from '../../../src/lib/core/common/base-model'

const Cell = z.object({ fieldId: z.string(), value: z.string() })

describe('BoundedArray', () => {
    it('parses a valid array to the element output', () => {
        const schema = BoundedArray({ element: z.coerce.string(), max: 3 })

        expect(schema.parse([1, 'a'])).toEqual(['1', 'a'])
    })

    it('rejects an oversized array with a single issue, without parsing its elements', () => {
        const element = z.string()
        const parse = vi.spyOn(element, 'safeParse')
        const schema = BoundedArray({ element, max: 3 })

        const result = schema.safeParse(Array(100_000).fill(1))

        expect(result.success).toBe(false)
        expect(result.error?.issues).toHaveLength(1)
        expect(result.error?.issues[0].code).toBe('too_big')
        expect(parse).not.toHaveBeenCalled()
    })

    it('stops at the first invalid element and reports only its issues, at its index', () => {
        const schema = z.object({ cells: BoundedArray({ element: Cell, max: 1000 }) })
        const cells = [{ fieldId: 'a', value: 'x' }, {}, ...Array(998).fill(1)]

        const result = schema.safeParse({ cells })

        expect(result.success).toBe(false)
        expect(result.error?.issues.map((issue) => issue.path)).toEqual([
            ['cells', 1, 'fieldId'],
            ['cells', 1, 'value'],
        ])
    })

    it('keeps nested arrays to the issues of one innermost element', () => {
        const schema = BoundedArray({ element: BoundedArray({ element: Cell, max: 1000 }), max: 1000 })

        const result = schema.safeParse(Array(1000).fill(Array(1000).fill(1)))

        expect(result.error?.issues).toHaveLength(1)
        expect(result.error?.issues[0].path).toEqual([0, 0])
    })

    it('scans each array of a recursive structure once, not once per enclosing level', () => {
        const Node: z.ZodType<TreeNode> = z.lazy(() => z.object({
            name: z.string(),
            children: BoundedArray({ element: Node, max: 10 }),
        }))
        const tree = Array.from({ length: 30 }).reduce<TreeNode>(
            (child, _, index) => ({ name: `n${index}`, children: [child, { name: 'leaf', children: [] }] }),
            { name: 'leaf', children: [] },
        )

        const started = performance.now()
        expect(Node.safeParse(tree).success).toBe(true)
        // Doubling per level would be 2^30 element parses; minutes, not milliseconds.
        expect(performance.now() - started).toBeLessThan(2000)
    })

    it('rejects an empty array when nonEmpty', () => {
        const schema = BoundedArray({ element: z.string(), max: 3, nonEmpty: true })

        expect(schema.safeParse([]).success).toBe(false)
        expect(schema.safeParse(['a']).success).toBe(true)
    })

    it('still rejects a value that is not an array', () => {
        const schema = BoundedArray({ element: z.string(), max: 3 })

        expect(schema.safeParse('a').error?.issues[0].code).toBe('invalid_type')
    })

    it('documents the element schema and the cap in JSON Schema', () => {
        const schema = BoundedArray({ element: Cell, max: 7 })

        expect(z.toJSONSchema(schema, { io: 'input' })).toMatchObject({
            type: 'array',
            maxItems: 7,
            items: { type: 'object', required: ['fieldId', 'value'] },
        })
    })
})

type TreeNode = {
    name: string
    children: TreeNode[]
}
