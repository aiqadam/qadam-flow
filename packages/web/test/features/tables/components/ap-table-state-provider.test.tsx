// @vitest-environment jsdom
import { Table, TableAutomationStatus } from '@aiqadam/shared';
import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  TableStateProviderWithTable,
  useTableState,
} from '@/features/tables/components/ap-table-state-provider';

// zustand v5 compares the snapshot with `Object.is` and no longer caches the selection, so a
// selector that returns a new array on every call loops. `useTableState` wraps its selector in
// `useShallow`; this renders a real table store through that wrapper and fails if the wrap is
// removed, which the type-only table tests cannot catch.
const table: Table = {
  id: 'table-1',
  created: '2024-01-01T00:00:00.000Z',
  updated: '2024-01-01T00:00:00.000Z',
  name: 'Test table',
  folderId: null,
  projectId: 'project-1',
  externalId: 'test-table',
  status: TableAutomationStatus.ENABLED,
  trigger: null,
  keyFieldIds: null,
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const mount = async (node: React.ReactNode): Promise<void> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
};

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  document.body.replaceChildren();
  container = undefined;
  root = undefined;
});

describe('useTableState with a fresh-reference selector', () => {
  it('renders a selector that returns a new array instead of looping', async () => {
    const Probe = () => {
      const [fields, records] = useTableState((s) => [s.fields, s.records]);
      return (
        <span>
          {fields.length}:{records.length}
        </span>
      );
    };

    await mount(
      <TableStateProviderWithTable table={table} fields={[]} records={[]}>
        <Probe />
      </TableStateProviderWithTable>,
    );

    expect(container?.textContent).toBe('0:0');
  });
});
