import { Field, FieldType } from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';
import { columnUtils } from '../src/lib/common/columns';

function field({ name, externalId }: { name: string; externalId: string }): Field {
  return {
    id: `id_${externalId}`,
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-01T00:00:00.000Z',
    name,
    externalId,
    type: FieldType.TEXT,
    tableId: 'table_1',
    projectId: 'project_1',
  };
}

const fields: Field[] = [
  field({ name: 'Display Name', externalId: 'display_name' }),
  field({ name: 'phone', externalId: 'phone' }),
  field({ name: 'consented', externalId: 'consented' }),
];

describe('columnUtils.toWireFieldIds', () => {
  it('resolves a column by display name, externalId and internal id alike', () => {
    expect(columnUtils.toWireFieldIds({ rawColumns: ['Display Name'], fields })).toEqual(['id_display_name']);
    expect(columnUtils.toWireFieldIds({ rawColumns: ['display_name'], fields })).toEqual(['id_display_name']);
    expect(columnUtils.toWireFieldIds({ rawColumns: ['id_display_name'], fields })).toEqual(['id_display_name']);
  });

  it('accepts a comma-separated string, which is what a hand-written step config holds', () => {
    expect(columnUtils.toWireFieldIds({ rawColumns: 'display_name, phone', fields })).toEqual(['id_display_name', 'id_phone']);
  });

  it('de-duplicates a column named twice', () => {
    expect(columnUtils.toWireFieldIds({ rawColumns: ['phone', 'Phone'], fields })).toEqual(['id_phone']);
  });

  // Selecting nothing must stay "every column" for back-compat, but a selection
  // that cannot be resolved must not quietly widen back to every column.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty list', []],
    ['an empty string', '   '],
  ])('treats %s as no projection', (_label, rawColumns) => {
    expect(columnUtils.toWireFieldIds({ rawColumns, fields })).toBeUndefined();
  });

  it('rejects a column the table does not have rather than returning every column', () => {
    expect(() => columnUtils.toWireFieldIds({ rawColumns: ['no_such_column'], fields })).toThrow(/no_such_column/);
    expect(() => columnUtils.toWireFieldIds({ rawColumns: ['display_name', 'no_such_column'], fields })).toThrow(/no_such_column/);
  });

  it('names the available columns in the error, so the fix is obvious', () => {
    expect(() => columnUtils.toWireFieldIds({ rawColumns: ['nope'], fields })).toThrow(/"Display Name", "phone", "consented"/);
  });

  it('rejects an ambiguous display name', () => {
    const ambiguous = [
      field({ name: 'Phone', externalId: 'phone_a' }),
      field({ name: 'Phone', externalId: 'phone_b' }),
    ];
    expect(() => columnUtils.toWireFieldIds({ rawColumns: ['Phone'], fields: ambiguous })).toThrow(/ambiguous/);
  });

  it('prefers an id over a display name, so resolution does not change when a column is renamed', () => {
    // `phone` is the externalId of the first column and the display name of the
    // second; the id wins, deterministically.
    const colliding = [
      field({ name: 'Mobile', externalId: 'phone' }),
      field({ name: 'phone', externalId: 'landline' }),
    ];
    expect(columnUtils.toWireFieldIds({ rawColumns: ['phone'], fields: colliding })).toEqual(['id_phone']);
  });

  it('rejects a non-scalar entry', () => {
    expect(() => columnUtils.toWireFieldIds({ rawColumns: [{ id: 'phone' }], fields })).toThrow(/not a column name or id/);
  });
});
