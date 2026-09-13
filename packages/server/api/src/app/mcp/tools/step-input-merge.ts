import { PropertyType, QadamPropertyMap } from '@aiqadam/qadams-framework'
import { isNil } from '@aiqadam/shared'

// `input` merges key by key, so a prop the caller never mentioned survives untouched. A DYNAMIC
// prop is the exception worth handling separately: its value is itself a map of sub-props, and a
// plain spread replaces that whole map — so naming one sub-field drops every other one. Merging a
// level deeper makes a partial update of `flowProps` behave the way a partial update of the step
// already does (#381). The cost is that a sub-field cannot be removed by omission; it has to be
// overwritten, which is the safer default for a value no read path can show the caller (#102).
function mergeDynamicProps({ currentInput, incomingInput, props }: {
    currentInput: Record<string, unknown> | undefined
    incomingInput: Record<string, unknown> | undefined
    props: QadamPropertyMap | undefined
}): Record<string, unknown> {
    if (isNil(incomingInput)) {
        return {}
    }
    if (isNil(props) || isNil(currentInput)) {
        return incomingInput
    }
    return Object.fromEntries(Object.entries(incomingInput).map(([key, incomingValue]) => {
        const isDynamic = props[key]?.type === PropertyType.DYNAMIC
        const currentValue = currentInput[key]
        if (!isDynamic || !isPlainObject(currentValue) || !isPlainObject(incomingValue)) {
            return [key, incomingValue]
        }
        return [key, { ...currentValue, ...incomingValue }]
    }))
}

// The failure this exists for is not "a bad value was accepted" but "a good value already in the
// step was destroyed by an update that never mentioned it" — and because no MCP tool can read a
// DYNAMIC prop back (#102), the caller cannot notice. A required prop that already held something
// and would end up empty is never a legitimate outcome of an update, so the write is refused
// instead of persisted with a green `valid`.
function findEmptiedRequiredProps({ currentInput, updatedInput, props }: {
    currentInput: Record<string, unknown> | undefined
    updatedInput: Record<string, unknown> | undefined
    props: QadamPropertyMap | undefined
}): string[] {
    if (isNil(props) || isNil(currentInput)) {
        return []
    }
    return Object.entries(props).flatMap(([propName, prop]) => {
        if (!prop.required) {
            return []
        }
        const before = currentInput[propName]
        const after = updatedInput?.[propName]
        if (isEmptyValue(before)) {
            return []
        }
        if (isEmptyValue(after)) {
            return [propName]
        }
        if (prop.type !== PropertyType.DYNAMIC || !isPlainObject(before) || !isPlainObject(after)) {
            return []
        }
        return Object.keys(before)
            .filter(field => !isEmptyValue(before[field]) && isEmptyValue(after[field]))
            .map(field => `${propName}.${field}`)
    })
}

function isEmptyValue(value: unknown): boolean {
    if (isNil(value) || value === '') {
        return true
    }
    if (Array.isArray(value)) {
        return value.length === 0
    }
    if (isPlainObject(value)) {
        return Object.keys(value).length === 0
    }
    return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const stepInputMerge = {
    mergeDynamicProps,
    findEmptiedRequiredProps,
}
