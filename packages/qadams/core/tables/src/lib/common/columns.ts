import { Field, tryCatchSync } from '@aiqadam/shared';

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

  // The security-relevant "what counts as not asked for" rule. Exported because
  // get-record short-circuits on it before resolving the table, and two copies
  // of this rule is exactly how the looser one survives a tightening of the other.
  isUnconfigured(rawColumns: unknown): boolean {
    return rawColumns === null || rawColumns === undefined || (Array.isArray(rawColumns) && rawColumns.length === 0);
  },

  describeAvailable(fields: Field[]): string {
    if (fields.length === 0) {
      return '(this table has no columns)';
    }
    return fields.map((field) => `"${field.name}"`).join(', ');
  },

  // Turns the Columns prop into the `fieldIds` the records API takes.
  //
  // Not configured means every column, for back-compat — and "not configured" is
  // only nothing at all or an empty list, which is what the builder stores for an
  // untouched multi-select. A value that IS there and yields no column is a
  // projection that could not be read, and widening that back to every column is
  // the exact failure this prop exists to prevent: a `{{...}}` binding resolving
  // to an empty string would put the whole row back in the run log.
  toWireFieldIds({ rawColumns, fields }: { rawColumns: unknown; fields: Field[] }): string[] | undefined {
    const value = unwrapJsonList(rawColumns);
    if (columnUtils.isUnconfigured(value)) {
      return undefined;
    }
    const identifiers = toIdentifiers(value);
    if (identifiers.length === 0) {
      throw new Error(`Columns is set but names no column. Remove it to return every column, or name the columns to return. Available columns: ${columnUtils.describeAvailable(fields)}.`);
    }
    const resolved = identifiers.map((identifier) => columnUtils.resolveColumn({ identifier, fields, position: 'Columns' }).id);
    return [...new Set(resolved)];
  },
};

// The builder writes JSON.stringify(value) when a non-string prop is toggled into
// dynamic mode, so an untouched multi-select arrives here as the literal "[]", and
// binding this prop to an upstream list arrives as `["a","b"]`. Comma-splitting
// those produces columns named `["a"` and `"b"]`. The sibling `filters` prop already
// JSON-parses a string for the same reason.
function unwrapJsonList(rawColumns: unknown): unknown {
  if (typeof rawColumns !== 'string' || !rawColumns.trim().startsWith('[')) {
    return rawColumns;
  }
  const { data, error } = tryCatchSync<unknown>(() => JSON.parse(rawColumns.trim()));
  return error === null && Array.isArray(data) ? data : rawColumns;
}

function toIdentifiers(rawColumns: unknown): string[] {
  if (!Array.isArray(rawColumns) && typeof rawColumns === 'object') {
    throw new Error('Columns is not a list of column names. Pass a list of column names, or leave it empty to return every column.');
  }
  const candidates = Array.isArray(rawColumns) ? rawColumns : String(rawColumns).split(',');
  return candidates.map((candidate) => {
    if (candidate === null || candidate === undefined || typeof candidate === 'object') {
      throw new Error('Columns holds a value that is not a column name or id. Pass a list of column names, or leave it empty to return every column.');
    }
    return String(candidate).trim();
  }).filter((identifier) => identifier.length > 0);
}
