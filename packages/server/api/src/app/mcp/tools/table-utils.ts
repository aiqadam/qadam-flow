import { Field, FieldType, PopulatedRecord, tryCatchSync } from '@aiqadam/shared'
import { z } from 'zod'
import { fieldService } from '../../tables/field/field.service'
import { mcpUtils } from './mcp-utils'

export async function resolveFieldNamesForTable({ projectId, tableId, fieldNames }: ResolveFieldNamesForTableParams): Promise<{ fields: Field[], fieldMap: Map<string, string>, errors: string[] }> {
    const fields = await fieldService.getAll({ projectId, tableId })
    const { fieldMap, errors } = resolveFieldNameToId({ fields, fieldNames })
    return { fields, fieldMap, errors }
}

export function resolveFieldNameToId({ fields, fieldNames }: ResolveFieldNameToIdParams): { fieldMap: Map<string, string>, errors: string[] } {
    const nameToField = new Map<string, Field>()
    const duplicates = new Set<string>()

    for (const field of fields) {
        const lower = field.name.toLowerCase()
        if (nameToField.has(lower)) {
            duplicates.add(lower)
        }
        else {
            nameToField.set(lower, field)
        }
    }

    const fieldMap = new Map<string, string>()
    const errors: string[] = []

    for (const name of fieldNames) {
        const lower = name.toLowerCase()
        if (duplicates.has(lower)) {
            // `name` here is an element of this call's own `fieldNames` argument — the caller's
            // own input, not a stored field/table value someone else wrote — so it sits outside
            // the #485 perimeter and stays bare, unlike the fetched `fields` list wrapped below.
            errors.push(`Duplicate field name "${name}". Rename one of them using ap_manage_fields before proceeding.`)
        }
        else if (!nameToField.has(lower)) {
            // Restored after #485 review: `field.name` is `z.string()` with no `STEP_NAME_REGEX`-
            // or `VARIABLE_NAME_REGEX`-style constraint on any write path (`CreateFieldRequest` /
            // `UpdateFieldRequest` in `fields.dto.ts`), so — unlike the step-name and variable-name
            // carve-outs this comment used to lean on — a newline is not merely possible here, it is
            // accepted by the schema. This list is also `\n`-joined with every other error in the
            // same batch (`ap-insert-records.ts`, `ap-update-record.ts`, `ap-find-records.ts`), so
            // one poisoned field name reaches the model on every failed lookup for the whole table.
            // The "must stay bare so a copied name still resolves" rationale doesn't survive either:
            // `ap-list-connections.ts` wraps `externalId` — a value with the exact same copy-back
            // shape — and both `mcp-server-builder.ts`'s server instructions and rule 28 of
            // `chat-system-prompt.md` now tell the model to strip `⟦`/`⟧` before reusing a wrapped
            // value as a tool argument, naming `fieldName` explicitly. A retry that skips that step
            // fails once, with a message the model was told to expect — a materially cheaper cost
            // than the header-forgery this list existed to prevent.
            errors.push(`Field "${name}" not found. Available fields: ${fields.map(f => mcpUtils.wrapUntrustedValue(f.name)).join(', ')}`)
        }
        else {
            fieldMap.set(name, nameToField.get(lower)!.id)
        }
    }

    return { fieldMap, errors }
}

const CELL_VALUE_PREVIEW_MAX = 2000

export function formatPopulatedRecord(record: PopulatedRecord): string {
    const lines = [`  Record ID: ${record.id}`]
    for (const cell of Object.values(record.cells)) {
        lines.push(`    ${mcpUtils.wrapUntrustedValue(cell.fieldName)}: ${formatCellValue(cell.value)}`)
    }
    return lines.join('\n')
}

export function formatFieldInfo(field: Field): string {
    if (field.type === FieldType.STATIC_DROPDOWN) {
        const options = field.data.options.map(o => mcpUtils.wrapUntrustedValue(o.value)).join(', ')
        return `${mcpUtils.wrapUntrustedValue(field.name)} (id: ${field.id}, type: ${field.type}, options: ${options})`
    }
    return `${mcpUtils.wrapUntrustedValue(field.name)} (id: ${field.id}, type: ${field.type})`
}

export const FIELD_TYPE_VALUES = [
    FieldType.TEXT,
    FieldType.NUMBER,
    FieldType.DATE,
    FieldType.STATIC_DROPDOWN,
    FieldType.BOOLEAN,
    FieldType.JSON,
] as const

export const fieldTypeSchema = z.enum(FIELD_TYPE_VALUES)

// `cell.value` is `z.unknown()` (jsonb-backed, `record.ts`'s own comment calls it unbounded) and
// can legally be a string, a number, a boolean, or an arbitrary JSON object/array written by a
// flow that wrote a webhook body or HTTP response into a table — reachable with no project-write
// access at all (#485). `JSON.stringify` already escapes an embedded newline into the two-char
// `\n` sequence, the same fidelity trade `ap-get-qadam-props.ts` accepts for the same reason, but
// it does nothing about a literal `⟦`/`⟧` or a confusable sitting inside a string value, so the
// wrap still runs on top of it — the two guard different things and neither subsumes the other.
// `JSON.stringify` can also throw (a `bigint`, though nothing on this path is expected to produce
// one) — `tryCatchSync` keeps that from taking the whole record listing down over one cell.
function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) {
        return '(empty)'
    }
    if (typeof value === 'string') {
        return mcpUtils.wrapTruncatedUntrustedValue({ value, max: CELL_VALUE_PREVIEW_MAX })
    }
    const { data: json } = tryCatchSync(() => JSON.stringify(value))
    return mcpUtils.wrapTruncatedUntrustedValue({ value: json ?? String(value), max: CELL_VALUE_PREVIEW_MAX })
}

type ResolveFieldNamesForTableParams = {
    projectId: string
    tableId: string
    fieldNames: string[]
}

type ResolveFieldNameToIdParams = {
    fields: Field[]
    fieldNames: string[]
}
