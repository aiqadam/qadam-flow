import { Field, FieldType, FilterOperator } from '@aiqadam/shared';
import { describe, expect, it } from 'vitest';
import { filterUtils } from '../src/lib/common/filters';

function field({ name, externalId, type }: { name: string; externalId: string; type: FieldType.TEXT | FieldType.NUMBER | FieldType.DATE }): Field {
  return {
    id: `id_${externalId}`,
    created: '2026-09-01T00:00:00.000Z',
    updated: '2026-09-01T00:00:00.000Z',
    name,
    externalId,
    type,
    tableId: 'table_1',
    projectId: 'project_1',
  };
}

// `starts_at` deliberately has a display name that is NOT its externalId, so the
// display-name resolution branch is actually reached — with name === externalId
// everywhere, that branch can be deleted with every test still green.
const fields: Field[] = [
  field({ name: 'event_id', externalId: 'event_id', type: FieldType.TEXT }),
  field({ name: 'Starts At', externalId: 'starts_at', type: FieldType.DATE }),
  field({ name: 'overbook_pct', externalId: 'overbook_pct', type: FieldType.NUMBER }),
];

describe('filterUtils.toWireFilters', () => {
  describe('shapes that must never degrade into an unfiltered read (#382)', () => {
    it('rejects a filter naming a column the table does not have', () => {
      expect(() =>
        filterUtils.toWireFilters({
          rawFilters: { filters: [{ field: 'no_such_column', operator: 'eq', value: 'demo' }] },
          fields,
        }),
      ).toThrow(/no_such_column/);
    });

    it('rejects an entry key it does not recognise instead of ignoring the entry', () => {
      expect(() =>
        filterUtils.toWireFilters({
          rawFilters: { filters: [{ fieldname: 'event_id', operator: 'eq', value: 'demo' }] },
          fields,
        }),
      ).toThrow(/unrecognised key/);
    });

    it('rejects a filters value that is neither a list nor a filter object', () => {
      expect(() => filterUtils.toWireFilters({ rawFilters: 42, fields })).toThrow(/Could not read/);
      expect(() => filterUtils.toWireFilters({ rawFilters: { scope: 'tenant' }, fields })).toThrow(/Could not read/);
    });

    it('rejects a JSON string it cannot parse', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: '{"filters":[{"field":"event_id"', fields }),
      ).toThrow(/Could not read/);
    });

    it('rejects an unrecognised operator', () => {
      expect(() =>
        filterUtils.toWireFilters({
          rawFilters: [{ field: 'event_id', operator: 'equals', value: 'demo' }],
          fields,
        }),
      ).toThrow(/unrecognised operator "equals"/);
    });

    it('rejects a value operator with no value', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'eq' }], fields }),
      ).toThrow(/requires a value/);
    });

    it('rejects an entry that names no column at all', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ operator: 'eq', value: 'demo' }], fields }),
      ).toThrow(/does not name a column/);
    });

    it('rejects an entry naming a column two different ways', () => {
      expect(() =>
        filterUtils.toWireFilters({
          rawFilters: [{ field: 'event_id', fieldName: 'starts_at', operator: 'exists' }],
          fields,
        }),
      ).toThrow(/names more than one column/);
    });
  });

  describe('shapes an API/MCP author actually writes', () => {
    it('accepts the builder shape, resolving the field descriptor to an internal id', () => {
      const result = filterUtils.toWireFilters({
        rawFilters: {
          filters: [{ field: { id: 'event_id', type: FieldType.TEXT, name: 'event_id' }, operator: 'eq', value: 'demo' }],
        },
        fields,
      });

      expect(result).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.EQ, value: 'demo' }]);
    });

    it('accepts a bare list of filters', () => {
      const result = filterUtils.toWireFilters({
        rawFilters: [{ field: 'event_id', operator: 'eq', value: 'demo' }],
        fields,
      });

      expect(result).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.EQ, value: 'demo' }]);
    });

    it('resolves a column by its display name, not only by its id', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ fieldName: 'Starts At', operator: 'exists' }], fields }),
      ).toEqual([{ fieldId: 'id_starts_at', operator: FilterOperator.EXISTS }]);
    });

    it('matches a display name case-insensitively', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ field: 'starts at', operator: 'exists' }], fields }),
      ).toEqual([{ fieldId: 'id_starts_at', operator: FilterOperator.EXISTS }]);
    });

    it('rejects a display name shared by two columns rather than picking one', () => {
      const ambiguous = [...fields, field({ name: 'Starts At', externalId: 'starts_at_2', type: FieldType.DATE })];
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'Starts At', operator: 'exists' }], fields: ambiguous }),
      ).toThrow(/ambiguous/);
    });

    it('accepts the field_id alias', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ field_id: 'overbook_pct', operator: 'gt', value: 10 }], fields }),
      ).toEqual([{ fieldId: 'id_overbook_pct', operator: FilterOperator.GT, value: '10' }]);
    });

    it('accepts the same column named twice through two different keys', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', fieldId: 'event_id', operator: 'exists' }], fields }),
      ).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.EXISTS }]);
    });

    // The two shapes from the report. The issue quotes them as the step's whole
    // `input`, so at the prop level the value is the bare array — which is what
    // the old `filters?.['filters'] ?? []` silently turned into "no filters".
    it.each([
      ['fieldName', [{ fieldName: 'event_id', operator: 'eq', value: 'demo' }]],
      ['field_id', [{ field_id: 'event_id', operator: 'eq', value: 'demo' }]],
    ])('resolves the reported %s shape that used to be dropped', (_label, rawFilters) => {
      expect(filterUtils.toWireFilters({ rawFilters, fields })).toEqual([
        { fieldId: 'id_event_id', operator: FilterOperator.EQ, value: 'demo' },
      ]);
    });

    it('accepts a nested list that resolved to a JSON string', () => {
      expect(
        filterUtils.toWireFilters({
          rawFilters: { filters: '[{"field":"event_id","operator":"eq","value":"demo"}]' },
          fields,
        }),
      ).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.EQ, value: 'demo' }]);
    });

    it('accepts a JSON string, which is what a hand-written step config often is', () => {
      const result = filterUtils.toWireFilters({
        rawFilters: '{"filters":[{"field":"event_id","operator":"neq","value":"demo"}]}',
        fields,
      });

      expect(result).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.NEQ, value: 'demo' }]);
    });

    it('accepts an upper-case operator', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'NOT_EXISTS' }], fields }),
      ).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.NOT_EXISTS }]);
    });
  });

  describe('an absent filter really is no filter', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['an empty object', {}],
      ['an empty list', []],
      ['an empty nested list', { filters: [] }],
      ['an empty string', '  '],
    ])('treats %s as no filters', (_label, rawFilters) => {
      expect(filterUtils.toWireFilters({ rawFilters, fields })).toEqual([]);
    });

    // Only the top-level value may mean "no filter". Once a "filters" key has
    // been written, an unreadable value under it is a dropped filter, and
    // reading it as "no filter" would return the whole table.
    it.each([
      ['an empty object', { filters: {} }],
      ['the string "{}"', { filters: '{}' }],
      ['the string "null"', { filters: 'null' }],
      ['null', { filters: null }],
      ['a blank string', { filters: '   ' }],
      ['a doubly nested empty object', { filters: { filters: {} } }],
    ])('rejects a "filters" key holding %s rather than reading the whole table', (_label, rawFilters) => {
      expect(() => filterUtils.toWireFilters({ rawFilters, fields })).toThrow(/holds nothing readable/);
    });
  });

  describe('value typing', () => {
    it('rejects a non-numeric value on a Number column', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'overbook_pct', operator: 'gt', value: 'ten' }], fields }),
      ).toThrow(/is not a number/);
    });

    it('rejects an unparseable date on a Date column', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'starts_at', operator: 'lt', value: 'yesterday' }], fields }),
      ).toThrow(/is not a date/);
    });

    it('rejects a blank value on a Number column, which Number() would read as 0', () => {
      for (const value of ['', '   ']) {
        expect(() =>
          filterUtils.toWireFilters({ rawFilters: [{ field: 'overbook_pct', operator: 'gt', value }], fields }),
        ).toThrow(/is not a number/);
      }
    });

    it('rejects an object where a single value is expected', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'eq', value: { id: 'demo' } }], fields }),
      ).toThrow(/takes a single value/);
    });
  });

  describe('list operators', () => {
    it('accepts a comma-separated string and a list variable alike', () => {
      const fromString = filterUtils.toWireFilters({
        rawFilters: [{ field: 'event_id', operator: 'in', value: 'a, b ,c' }],
        fields,
      });
      const fromList = filterUtils.toWireFilters({
        rawFilters: [{ field: 'event_id', operator: 'in', value: ['a', 'b', 'c'] }],
        fields,
      });

      expect(fromString).toEqual([{ fieldId: 'id_event_id', operator: FilterOperator.IN, value: ['a', 'b', 'c'] }]);
      expect(fromList).toEqual(fromString);
    });

    it('rejects an empty list rather than matching everything', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'not_in', value: '  ' }], fields }),
      ).toThrow(/requires at least one value/);
    });

    it('rejects a list element that is not a single scalar', () => {
      // String()-coercing these silently changes what the filter means:
      // [{a:1}] would become "[object Object]" and [['a','b']] a single "a,b".
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'in', value: [{ a: 1 }] }], fields }),
      ).toThrow(/not a single text, number or boolean/);
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'event_id', operator: 'in', value: [['a', 'b']] }], fields }),
      ).toThrow(/not a single text, number or boolean/);
    });
  });

  describe('number values the server would read differently', () => {
    it('rejects a hex literal, which the server compares as 0', () => {
      expect(() =>
        filterUtils.toWireFilters({ rawFilters: [{ field: 'overbook_pct', operator: 'gt', value: '0x10' }], fields }),
      ).toThrow(/is not a number/);
    });

    it('still accepts exponent notation, which both sides read the same way', () => {
      expect(
        filterUtils.toWireFilters({ rawFilters: [{ field: 'overbook_pct', operator: 'gt', value: '1e2' }], fields }),
      ).toEqual([{ fieldId: 'id_overbook_pct', operator: FilterOperator.GT, value: '1e2' }]);
    });
  });
});
