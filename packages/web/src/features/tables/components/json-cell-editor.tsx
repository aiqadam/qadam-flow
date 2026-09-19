import { t } from 'i18next';
import { useEffect, useRef, useState } from 'react';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

import { useCellContext } from './cell-context';

// Cells are always strings on the wire, including for JSON fields (an empty string is the
// "unset" value, mirroring BOOLEAN's tri-state empty/'true'/'false').
function isValidJson(value: string) {
  if (value.trim().length === 0) {
    return true;
  }
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

// Mirrors TextEditor's overlay pattern, but a failed commit keeps editing mode active with
// an error border instead of writing invalid JSON — matching the server's own write-time
// validation (cell-validation.ts) rather than silently discarding the user's input.
const JsonCellEditor = () => {
  const { value, handleCellChange, setIsEditing, isEditing } = useCellContext();
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState(value);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (isEditing) {
      textAreaRef.current?.focus();
    }
    setInputValue(value);
    setHasError(false);
  }, [isEditing]);

  const commit = () => {
    if (!isValidJson(inputValue)) {
      setHasError(true);
      return;
    }
    handleCellChange(inputValue);
  };

  return (
    <div className="h-full relative w-full">
      <div
        className={cn({
          'h-min-[300px] w-min-[calc(100%+50px)] w-full absolute top-0  z-50 border-2 border-primary  drop-shadow-md':
            isEditing,
        })}
      >
        {isEditing && (
          <>
            <Textarea
              ref={textAreaRef}
              value={inputValue}
              onChange={(e) => {
                setInputValue(e.target.value);
                setHasError(false);
              }}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && !e.shiftKey) {
                  commit();
                  e.preventDefault();
                }
                if (e.key === 'Escape') {
                  setIsEditing(false);
                  e.preventDefault();
                }
              }}
              minRows={4}
              maxRows={6}
              className={cn(
                'flex-1 h-full min-w-0 rounded-none',
                'border-none text-sm px-2 resize-none ',
                'focus:outline-hidden',
                'placeholder:text-muted-foreground',
                hasError && 'border-destructive',
              )}
              autoComplete="off"
            />
            {hasError && (
              <div className="px-2 pb-1 text-xs text-destructive bg-background">
                {t('Invalid JSON')}
              </div>
            )}
          </>
        )}
        {!isEditing && (
          <div className="flex grow h-full w-full min-w-0 items-center">
            <TextWithTooltip tooltipMessage={value}>
              <p className="truncate">{value}</p>
            </TextWithTooltip>
          </div>
        )}
      </div>
    </div>
  );
};
JsonCellEditor.displayName = 'JsonCellEditor';
export { JsonCellEditor };
