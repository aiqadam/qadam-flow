import { Field } from '@aiqadam/shared';

export const columnUtils = {
  // Resolves one identifier — a column's display name, externalId or internal id —
  // against the table's real columns. Shared with the filter resolver so the two
  // cannot drift in what they accept.
  resolveColumn({ identifier, fields, position }: { identifier: string; fields: Field[]; position: string }): Field {
    // Ids win over display names, deterministically: an externalId is caller-supplied
    // at field creation, so it can collide with another column's display name, and a
    // stable precedence is better than resolving differently as columns are renamed.
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

    throw new Error(`${position} names column "${identifier}", which this table does not have. Available columns: ${columnUtils.describeAvailable(fields)}.`);
  },

  describeAvailable(fields: Field[]): string {
    if (fields.length === 0) {
      return '(this table has no columns)';
    }
    return fields.map((field) => `"${field.name}"`).join(', ');
  },

  // Turns the Columns prop into the `fieldIds` the records API takes. Selecting
  // nothing means every column, for back-compat; but a selection that names a
  // column the table does not have raises rather than quietly widening the read
  // back to every column, which is what the projection exists to prevent.
  toWireFieldIds({ rawColumns, fields }: { rawColumns: unknown; fields: Field[] }): string[] | undefined {
    const identifiers = toIdentifiers(rawColumns);
    if (identifiers.length === 0) {
      return undefined;
    }
    const resolved = identifiers.map((identifier) => columnUtils.resolveColumn({ identifier, fields, position: 'Columns' }).id);
    return [...new Set(resolved)];
  },
};

function toIdentifiers(rawColumns: unknown): string[] {
  if (rawColumns === null || rawColumns === undefined) {
    return [];
  }
  const candidates = Array.isArray(rawColumns) ? rawColumns : String(rawColumns).split(',');
  return candidates.map((candidate) => {
    if (candidate === null || candidate === undefined || typeof candidate === 'object') {
      throw new Error(`Columns holds a value that is not a column name or id. Pass a list of column names, or leave it empty to return every column.`);
    }
    return String(candidate).trim();
  }).filter((identifier) => identifier.length > 0);
}
