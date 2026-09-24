import { tryCatchSync } from '@aiqadam/shared'
import { FastifySchemaCompiler, FastifySchemaValidationError } from 'fastify'
import { validatorCompiler } from 'fastify-type-provider-zod'
import { $ZodType } from 'zod/v4/core'

// zod reports one issue per invalid element and Fastify joins every issue into the 400
// message, so an unbounded array of bad elements turns a small body into a response
// (and a log line) many times its size. Ten is enough to debug a client.
const MAX_REPORTED_VALIDATION_ISSUES = 10

export const requestValidator: RequestValidator = {
    compiler: (routeSchema) => {
        const validate = validatorCompiler(routeSchema)
        return (data) => {
            // A schema can throw instead of reporting: zod overflows the stack aggregating
            // a very large nested issue list, and a refine may throw on input an earlier
            // check already rejected. Fastify turns a throwing validator into a 500; the
            // input is what is wrong, so it is a 400.
            const { data: result, error } = tryCatchSync(() => validate(data))
            if (error) {
                return { error: [unvalidatableInputIssue()] }
            }
            if (hasValidationIssues(result)) {
                return { error: capIssues(result.error) }
            }
            return result
        }
    },
}

function hasValidationIssues(result: unknown): result is { error: FastifySchemaValidationError[] } {
    return typeof result === 'object' && result !== null && 'error' in result && Array.isArray(result.error)
}

function capIssues(issues: FastifySchemaValidationError[]): FastifySchemaValidationError[] {
    if (issues.length <= MAX_REPORTED_VALIDATION_ISSUES) {
        return issues
    }
    const omitted = issues.length - MAX_REPORTED_VALIDATION_ISSUES
    return [
        ...issues.slice(0, MAX_REPORTED_VALIDATION_ISSUES),
        {
            keyword: 'truncated',
            instancePath: '',
            schemaPath: '#',
            params: { omitted },
            message: `(${omitted} more issues not shown)`,
        },
    ]
}

function unvalidatableInputIssue(): FastifySchemaValidationError {
    return {
        keyword: 'invalid',
        instancePath: '',
        schemaPath: '#',
        params: {},
        message: 'could not be validated',
    }
}

type RequestValidator = {
    compiler: FastifySchemaCompiler<$ZodType>
}
