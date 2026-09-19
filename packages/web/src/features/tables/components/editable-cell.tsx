import { FieldType } from '@aiqadam/shared';
import { useEffect, useRef, useState } from 'react';
import { CalculatedColumn } from 'react-data-grid';
import { ErrorBoundary } from 'react-error-boundary';

import { cn } from '@/lib/utils';

import { ClientField } from '../stores/store/ap-tables-client-state';
import { Row } from '../types/types';

import { useTableState } from './ap-table-state-provider';
import { BooleanEditor } from './boolean-editor';
import { CellProvider } from './cell-context';
import { DateEditor } from './date-editor';
import { DropdownEditor } from './dropdown-editor';
import { JsonCellEditor } from './json-cell-editor';
import { NumberEditor } from './number-editor';
import { TextEditor } from './text-editor';

type EditableCellProps = {
  field: ClientField;
  value?: string;
  row: Row;
  onClick?: () => void;
  column: CalculatedColumn<Row, { id: string }>;
  rowIdx: number;
  disabled?: boolean;
  locked?: boolean;
};

const EditorSelector = ({ fieldType }: { fieldType: FieldType }) => {
  switch (fieldType) {
    case FieldType.DATE:
      return <DateEditor />;
    case FieldType.NUMBER:
      return <NumberEditor />;
    case FieldType.STATIC_DROPDOWN:
      return <DropdownEditor></DropdownEditor>;
    case FieldType.BOOLEAN:
      return <BooleanEditor />;
    case FieldType.JSON:
      return <JsonCellEditor />;
    default:
      return <TextEditor />;
  }
};

const useSetInitialFocus = (isSelected: boolean) => {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => {
      if (isSelected) {
        containerRef.current?.focus();
      }
    });
  }, []);
  return containerRef;
};

export function EditableCell({
  field,
  column,
  rowIdx,
  onClick,
  locked = false,
  value,
  disabled = false,
}: EditableCellProps) {
  const [selectedCell, setSelectedCell, records, fields] = useTableState(
    (state) => [
      state.selectedCell,
      state.setSelectedCell,
      state.records,
      state.fields,
    ],
  );
  const [isEditing, setIsEditing] = useState(false);
  const isSelected =
    selectedCell?.rowIdx === rowIdx && selectedCell?.columnIdx === column.idx;
  const containerRef = useSetInitialFocus(isSelected);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const isTypingKey = e.key.length === 1 || e.key === 'Enter';
    if (isTypingKey && !disabled && !isEditing) {
      setIsEditing(true);
      setSelectedCell({ rowIdx, columnIdx: column.idx });
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    // react data grid cells are all focusable and they have no api to prevent focus
    // so we need to prevent the default behavior of the arrow keys
    switch (e.key) {
      case 'ArrowUp': {
        if (rowIdx === 0) {
          e.preventDefault();
          e.stopPropagation();
        }
        break;
      }
      case 'ArrowDown': {
        if (rowIdx === records.length - 1) {
          e.preventDefault();
          e.stopPropagation();
        }
        break;
      }
      case 'ArrowLeft':
        if (column.idx === 1) {
          e.preventDefault();
          e.stopPropagation();
        }
        break;
      case 'ArrowRight': {
        if (column.idx === fields.length) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    }
  };
  // These editors control their own padding/centering rather than relying on the
  // wrapper's default text padding — a dropdown control needs to fill its trigger, and a
  // checkbox needs to be centered rather than left-padded like text.
  const isSelfPadded =
    field.type === FieldType.STATIC_DROPDOWN ||
    field.type === FieldType.BOOLEAN;
  return (
    <div
      ref={containerRef}
      id={`editable-cell-${rowIdx}-${column.idx}`}
      className={
        isEditing
          ? 'h-full w-full'
          : cn(
              'h-full flex items-center justify-between gap-2  focus:outline-hidden  ',
              'group cursor-pointer border',
              isSelected && !locked ? 'border-primary' : 'border-transparent',
              locked && 'locked-row',
              !isSelfPadded && 'pl-2 py-2',
            )
      }
      tabIndex={0}
      onClick={() => {
        onClick?.();
        setSelectedCell({ rowIdx, columnIdx: column.idx });
      }}
      onFocus={() => {
        setSelectedCell({ rowIdx, columnIdx: column.idx });
      }}
      onDoubleClick={() => {
        if (!disabled) {
          setIsEditing(true);
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <ErrorBoundary fallback={<div>Error</div>}>
        <CellProvider
          rowIdx={rowIdx}
          columnIdx={column.idx - 1}
          fieldType={field.type}
          value={value ?? ''}
          handleCellChange={() => {}}
          containerRef={containerRef}
          isEditing={isEditing}
          setIsEditing={setIsEditing}
          disabled={disabled}
        >
          <EditorSelector fieldType={field.type} />
        </CellProvider>
      </ErrorBoundary>
    </div>
  );
}
