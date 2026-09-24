import { FastifySchemaValidationError } from 'fastify'
import { z } from 'zod'
import { requestValidator } from '../../../../src/app/helper/request-validator'

describe('requestValidator.compiler', () => {
    it('passes a valid value through', () => {
        const validate = compile(z.object({ a: z.coerce.number() }))

        expect(validate({ a: '1' })).toEqual({ value: { a: 1 } })
    })

    it('reports every issue when there are at most ten', () => {
        const validate = compile(z.array(z.string()))

        expect(issuesOf(validate(Array(10).fill(1)))).toHaveLength(10)
    })

    it('reports ten issues and how many it left out', () => {
        const validate = compile(z.array(z.string()))

        const issues = issuesOf(validate(Array(1000).fill(1)))

        expect(issues).toHaveLength(11)
        expect(issues[10].message).toBe('(990 more issues not shown)')
    })

    it('answers an issue instead of throwing when the schema throws', () => {
        const validate = compile(z.string().refine(() => {
            throw new TypeError('Invalid URL')
        }))

        const issues = issuesOf(validate('x'))

        expect(issues).toHaveLength(1)
        expect(issues[0].message).toBe('could not be validated')
    })

    it('does not let a request through when the schema throws a falsy value', () => {
        const validate = compile(z.string().refine(() => {
            throw undefined
        }))

        expect(issuesOf(validate('x'))).toHaveLength(1)
    })
})

function compile(schema: z.ZodType): (data: unknown) => unknown {
    return requestValidator.compiler({ schema, method: 'POST', url: '/', httpPart: 'body' })
}

function issuesOf(result: unknown): FastifySchemaValidationError[] {
    if (typeof result === 'object' && result !== null && 'error' in result && Array.isArray(result.error)) {
        return result.error
    }
    throw new Error('expected validation issues')
}
