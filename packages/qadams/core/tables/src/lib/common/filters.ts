import { Field, FieldType, Filter, FilterOperator } from '@aiqadam/shared';

export const filterUtils = {
  // Builds the wire filters for GET /v1/records. Every shape below was produced
  // by a real author configuring the step as JSON through the API or MCP rather
  // than through the builder's picker. Anything outside them raises: a filter
  // whose shape is not understood must never degrade into "no filter", because
  // that returns the whole table and reads exactly like "everything matched".
  toWireFilters({ rawFilters, fields }: { rawFilters: unknown; fields: Field[] }): Filter[] {
    return toEntries(rawFilters).map((entry, index) => toWireFilter({ entry, index, fields }));
  },

  // "In" / "Not In" accept either a list variable or a comma-separated string.
  toFilterList(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map(String).map((part) => part.trim()).filter((part) => part.length > 0);
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

function toEntries(rawFilters: unknown): unknown[] {
  if (rawFilters === null || rawFilters === undefined) {
    return [];
  }
  if (typeof rawFilters === 'string') {
    const trimmed = rawFilters.trim();
    if (trimmed.length === 0) {
      return [];
    }
    return toEntries(parseJsonOrThrow(trimmed));
  }
  if (Array.isArray(rawFilters)) {
    return rawFilters;
  }
  if (!isRecord(rawFilters)) {
    throw new Error(unrecognisedShapeMessage(rawFilters));
  }
  const keys = Object.keys(rawFilters);
  if (keys.length === 0) {
    return [];
  }
  if (NESTED_KEY in rawFilters) {
    // Recursive rather than three explicit branches, because the builder's
    // inline-item mode can resolve the nested array to a JSON string.
    return toEntries(rawFilters[NESTED_KEY]);
  }
  if (keys.some((key) => ENTRY_KEYS.includes(key))) {
    return [rawFilters];
  }
  throw new Error(unrecognisedShapeMessage(rawFilters));
}

function parseJsonOrThrow(raw: string): unknown {
  try {
    return JSON.parse(raw);
  }
  catch {
    throw new Error(unrecognisedShapeMessage(raw));
  }
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
      const values = filterUtils.toFilterList(entry['value']);
      if (values.length === 0) {
        throw new Error(`${position}: the "${operator}" operator on field "${field.name}" requires at least one value.`);
      }
      // Deliberately not type-checked per element: these operators are a string
      // set membership test, an element that does not parse simply fails to
      // match, and rejecting one would break flows that work today.
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

  const identifier = unique[0];
  const byId = fields.find((field) => field.externalId === identifier || field.id === identifier);
  if (byId !== undefined) {
    return byId;
  }

  const byName = fields.filter((field) => field.name.toLowerCase() === identifier.toLowerCase());
  if (byName.length > 1) {
    throw new Error(`${position} names column "${identifier}", which is ambiguous — the table has more than one column with that name. Use the column id instead.`);
  }
  if (byName.length === 1) {
    return byName[0];
  }

  throw new Error(`${position} names column "${identifier}", which this table does not have. Available columns: ${availableColumns(fields)}.`);
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
  switch (field.type) {
    case FieldType.NUMBER: {
      if (value.trim().length === 0 || !Number.isFinite(Number(value))) {
        throw new Error(`${position}: "${truncate(value)}" is not a number, but field "${field.name}" is a Number column.`);
      }
      return;
    }
    case FieldType.DATE: {
      if (Number.isNaN(new Date(value).getTime())) {
        throw new Error(`${position}: "${truncate(value)}" is not a date, but field "${field.name}" is a Date column.`);
      }
      return;
    }
    case FieldType.TEXT:
    case FieldType.STATIC_DROPDOWN:
      return;
  }
}

function availableColumns(fields: Field[]): string {
  if (fields.length === 0) {
    return '(this table has no columns)';
  }
  return fields.map((field) => `"${field.name}"`).join(', ');
}

// Describes the shape rather than dumping the value: this message is persisted
// into the run output, and the filters value can carry whatever the flow put in
// it. The keys are enough to see what went wrong.
function unrecognisedShapeMessage(value: unknown): string {
  const shape = isRecord(value)
    ? `an object with key(s) ${quoteAll(Object.keys(value).slice(0, MAX_REPORTED_KEYS))}`
    : `a value of type ${Array.isArray(value) ? 'array' : typeof value}`;
  return `Could not read the "filters" value — got ${shape}. ${SHAPE_HINT} A filter that cannot be read is rejected rather than ignored, because ignoring it would return every row in the table.`;
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
