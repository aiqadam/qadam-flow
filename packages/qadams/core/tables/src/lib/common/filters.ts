import { Field, FieldType, Filter, FilterOperator, tryCatchSync } from '@aiqadam/shared';
import { columnUtils } from './columns';

export const filterUtils = {
  // Builds the wire filters for GET /v1/records. Every shape below was produced
  // by a real author configuring the step as JSON through the API or MCP rather
  // than through the builder's picker. Anything outside them raises: a filter
  // whose shape is not understood must never degrade into "no filter", because
  // that returns the whole table and reads exactly like "everything matched".
  toWireFilters({ rawFilters, fields }: { rawFilters: unknown; fields: Field[] }): Filter[] {
    return toEntries({ value: rawFilters, nested: false }).map((entry, index) => toWireFilter({ entry, index, fields }));
  },

  // "In" / "Not In" accept either a list variable or a comma-separated string.
  toFilterList({ value, position, fieldName }: { value: unknown; position: string; fieldName: string }): string[] {
    if (Array.isArray(value)) {
      return value
        .map((element) => {
          if (element === null || element === undefined || typeof element === 'object') {
            // String()-coercing these would build a filter that means something
            // other than what was written: [{a:1}] becomes "[object Object]" and
            // [['a','b']] becomes the single value "a,b".
            throw new Error(`${position}: the list for field "${fieldName}" holds a value that is not a single text, number or boolean.`);
          }
          return String(element).trim();
        })
        .filter((part) => part.length > 0);
    }
    return String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// `nested` is load-bearing. Only the TOP-LEVEL value may mean "no filter" — that
// is what an optional, unconfigured prop looks like. Once an author has written
// a `filters` key, an empty or absent value under it is a filter that could not
// be read, and reading it as "no filter" would return the whole table.
function toEntries({ value, nested }: { value: unknown; nested: boolean }): unknown[] {
  if (value === null || value === undefined) {
    return nested ? emptyNestedValue(value) : [];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return nested ? emptyNestedValue(value) : [];
    }
    return toEntries({ value: parseJsonOrThrow(trimmed), nested });
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    throw new Error(unrecognisedShapeMessage(value));
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return nested ? emptyNestedValue(value) : [];
  }
  if (NESTED_KEY in value) {
    // Recursive rather than three explicit branches, because the builder's
    // inline-item mode can resolve the nested array to a JSON string.
    return toEntries({ value: value[NESTED_KEY], nested: true });
  }
  if (keys.some((key) => ENTRY_KEYS.includes(key))) {
    return [value];
  }
  throw new Error(unrecognisedShapeMessage(value));
}

function emptyNestedValue(value: unknown): never {
  throw new Error(`The "filters" key is present but holds nothing readable (${describeShape(value)}). ${SHAPE_HINT} Write no "filters" key at all to read the whole table on purpose.`);
}

function parseJsonOrThrow(raw: string): unknown {
  const { data, error } = tryCatchSync<unknown>(() => JSON.parse(raw));
  if (error !== null) {
    throw new Error(unrecognisedShapeMessage(raw));
  }
  return data;
}

function toWireFilter({ entry, index, fields }: { entry: unknown; index: number; fields: Field[] }): Filter {
  const position = `Filter #${index + 1}`;
  if (!isRecord(entry)) {
    throw new Error(`${position} is not an object. ${SHAPE_HINT}`);
  }

  const unknownKeys = Object.keys(entry).filter((key) => !ENTRY_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${position} has unrecognised key(s) ${quoteAll(unknownKeys)}. Accepted keys are ${quoteAll(ENTRY_KEYS)}.`);
  }

  const operator = resolveOperator({ entry, position });
  const field = resolveField({ entry, position, fields });

  switch (operator) {
    case FilterOperator.EXISTS:
    case FilterOperator.NOT_EXISTS:
      return { fieldId: field.id, operator };
    case FilterOperator.IN:
    case FilterOperator.NOT_IN: {
      const values = filterUtils.toFilterList({ value: entry['value'], position, fieldName: field.name });
      if (values.length === 0) {
        throw new Error(`${position}: the "${operator}" operator on field "${field.name}" requires at least one value.`);
      }
      // Each element is required to be a scalar (toFilterList enforces that), but
      // deliberately not checked against the column's type: these operators are a
      // string set membership test, an element that does not parse simply fails
      // to match, and rejecting one would break flows that work today.
      return { fieldId: field.id, operator, value: values };
    }
    case FilterOperator.EQ:
    case FilterOperator.NEQ:
    case FilterOperator.GT:
    case FilterOperator.GTE:
    case FilterOperator.LT:
    case FilterOperator.LTE:
    case FilterOperator.CO: {
      const value = toScalarValue({ raw: entry['value'], field, operator, position });
      assertValueMatchesFieldType({ field, value, position });
      return { fieldId: field.id, operator, value };
    }
  }
}

function resolveOperator({ entry, position }: { entry: Record<string, unknown>; position: string }): FilterOperator {
  const raw = entry['operator'];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${position} is missing an "operator". Accepted operators are ${quoteAll(ALL_OPERATORS)}.`);
  }
  const normalised = raw.trim().toLowerCase();
  const operator = ALL_OPERATORS.find((candidate) => candidate === normalised);
  if (operator === undefined) {
    throw new Error(`${position} has an unrecognised operator "${raw}". Accepted operators are ${quoteAll(ALL_OPERATORS)}.`);
  }
  return operator;
}

function resolveField({ entry, position, fields }: { entry: Record<string, unknown>; position: string; fields: Field[] }): Field {
  const identifiers = FIELD_KEYS.flatMap((key) => {
    const raw = entry[key];
    if (raw === null || raw === undefined) {
      return [];
    }
    // The builder's picker stores the whole field descriptor, not just its id.
    const candidate = key === 'field' && isRecord(raw) ? raw['id'] : raw;
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw new Error(`${position} has a "${key}" that is not a column name or id. ${SHAPE_HINT}`);
    }
    return [candidate.trim()];
  });

  const unique = [...new Set(identifiers)];
  if (unique.length === 0) {
    throw new Error(`${position} does not name a column. Use "field" with a column name or id. ${SHAPE_HINT}`);
  }
  if (unique.length > 1) {
    throw new Error(`${position} names more than one column (${quoteAll(unique)}). Use exactly one of ${quoteAll(FIELD_KEYS)}.`);
  }

  return columnUtils.resolveColumn({ identifier: unique[0], fields, position });
}

function toScalarValue({ raw, field, operator, position }: { raw: unknown; field: Field; operator: FilterOperator; position: string }): string {
  if (raw === null || raw === undefined) {
    throw new Error(`${position}: the "${operator}" operator on field "${field.name}" requires a value.`);
  }
  if (typeof raw === 'object') {
    throw new Error(`${position}: the "${operator}" operator on field "${field.name}" takes a single value, not ${Array.isArray(raw) ? 'a list' : 'an object'}.`);
  }
  return String(raw);
}

function assertValueMatchesFieldType({ field, value, position }: { field: Field; value: string; position: string }): void {
  const { name, type } = field;
  switch (type) {
    case FieldType.NUMBER: {
      if (!isDecimalNumber(value)) {
        throw new Error(`${position}: "${truncate(value)}" is not a number, but field "${name}" is a Number column.`);
      }
      return;
    }
    case FieldType.DATE: {
      if (Number.isNaN(new Date(value).getTime())) {
        throw new Error(`${position}: "${truncate(value)}" is not a date, but field "${name}" is a Date column.`);
      }
      return;
    }
    case FieldType.TEXT:
    case FieldType.STATIC_DROPDOWN:
      return;
    default: {
      // A new FieldType must not silently skip validation here. Reports the type
      // only — the field itself carries per-type data that has no business in a
      // run log.
      const unhandled: never = type;
      throw new Error(`${position}: column "${name}" is of type ${String(unhandled)}, which this action cannot validate.`);
    }
  }
}

// Both `Number` and `parseFloat` have to agree, because the server compares with
// one and this validates with the other: `Number('0x10')` is 16 where
// `parseFloat('0x10')` is 0, so accepting hex here would pass a value the server
// then evaluates as something else entirely.
function isDecimalNumber(value: string): boolean {
  // Explicit rather than leaning on the disagreement below (`Number('') === 0`
  // but `parseFloat('')` is NaN, so blanks would be rejected either way): a
  // blank value must not depend on that coincidence to be caught.
  if (value.trim().length === 0) {
    return false;
  }
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && asNumber === parseFloat(value);
}

// Describes the shape rather than dumping the value: this message is persisted
// into the run output, and the filters value can carry whatever the flow put in
// it. The keys are enough to see what went wrong.
function unrecognisedShapeMessage(value: unknown): string {
  return `Could not read the "filters" value — got ${describeShape(value)}. ${SHAPE_HINT} A filter that cannot be read is rejected rather than ignored, because ignoring it would return every row in the table.`;
}

function describeShape(value: unknown): string {
  if (isRecord(value)) {
    const keys = Object.keys(value);
    return keys.length === 0 ? 'an empty object' : `an object with key(s) ${quoteAll(keys.slice(0, MAX_REPORTED_KEYS))}`;
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  if (typeof value === 'string') {
    return value.trim().length === 0 ? 'an empty text' : 'a text';
  }
  return `a value of type ${typeof value}`;
}

function truncate(value: string): string {
  return value.length <= MAX_REPORTED_VALUE_LENGTH ? value : `${value.slice(0, MAX_REPORTED_VALUE_LENGTH)}…`;
}

function quoteAll(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

const NESTED_KEY = 'filters';

const FIELD_KEYS = ['field', 'fieldId', 'field_id', 'fieldName', 'field_name'] as const;

const ENTRY_KEYS: readonly string[] = [...FIELD_KEYS, 'operator', 'value'];

const ALL_OPERATORS: readonly FilterOperator[] = Object.values(FilterOperator);

const MAX_REPORTED_KEYS = 10;

const MAX_REPORTED_VALUE_LENGTH = 100;

const SHAPE_HINT = 'Expected {"filters":[{"field":"<column name or id>","operator":"eq","value":"..."}]}.';
