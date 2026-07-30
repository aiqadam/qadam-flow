import { useEffect, useRef, useState } from 'react';

import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { formatUtils } from '@/lib/format-utils';
import { localeUtils } from '@/lib/locale-utils';
import { cn } from '@/lib/utils';

import { useCellContext } from './cell-context';

// Two different string formats meet in this component and must never be parsed with the same
// function: the cell's stored value is an ISO timestamp, while the input holds whatever the user
// typed in their own locale's field order. Parsing typed input as ISO is what silently cleared
// cells on every locale that writes the day first.
function parseStoredValue(value: string) {
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

function parseTypedValue(value: string) {
  return localeUtils.parseLocaleDate({
    value,
    locale: localeUtils.getActiveLocale(),
  });
}

function getFormattedDate(date: string) {
  const parsed = parseStoredValue(date);
  return parsed ? formatUtils.formatDateOnly(parsed) : '';
}
function DateEditor() {
  const { value, handleCellChange, setIsEditing, isEditing } = useCellContext();
  const [date, setDate] = useState<Date | undefined>(parseStoredValue(value));
  const [month, setMonth] = useState<Date | undefined>(parseStoredValue(value));
  const [inputValue, setInputValue] = useState(getFormattedDate(value));
  const handleSelect = (newDate: Date | undefined) => {
    setDate(newDate);
    if (newDate) {
      // react-day-picker hands back local midnight. Normalising to local noon, as the typed path
      // does, keeps a picked date and a typed date storing the same instant — otherwise the same
      // calendar day serialises to two different UTC days depending on how the user chose it.
      const atNoon = new Date(
        newDate.getFullYear(),
        newDate.getMonth(),
        newDate.getDate(),
        12,
      );
      setInputValue(formatUtils.formatDateOnly(atNoon));
      handleCellChange(atNoon.toISOString());
      setIsEditing(false);
    }
  };

  // Only an explicitly emptied input may clear the cell. Committing on an unparseable value is
  // how an edit to an existing date destroyed it instead of updating it, so unparseable input
  // reverts the text to the stored date and writes nothing.
  const commit = () => {
    if (inputValue.trim() === '') {
      // An empty field is only an instruction to clear when there was something the user could
      // have deleted. getFormattedDate() also returns '' for a stored value it cannot render — a
      // date imported from CSV as plain locale text, say — and committing that would destroy it.
      if (value !== '' && !parseStoredValue(value)) {
        return;
      }
      handleCellChange('');
      return;
    }
    const typed = parseTypedValue(inputValue);
    if (!typed) {
      setInputValue(getFormattedDate(value));
      return;
    }
    handleCellChange(typed.toISOString());
  };

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isEditing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    } else {
      setInputValue(getFormattedDate(value));
    }
  }, [isEditing]);
  return (
    <div className="h-full w-full" ref={containerRef}>
      <Popover
        open={isEditing}
        onOpenChange={(open) => {
          if (!open) {
            setIsEditing(false);
          }
        }}
      >
        <PopoverTrigger asChild>
          <button
            className={cn(
              'w-full h-full flex items-center justify-between gap-2',
              'bg-background text-sm px-2',
              'focus:outline-hidden',
              {
                'border-2 border-primary': isEditing,
                'border-transparent bg-transparent!': !isEditing,
              },
            )}
          >
            {isEditing && (
              <input
                ref={inputRef}
                placeholder={localeUtils.getDatePlaceholder({
                  locale: localeUtils.getActiveLocale(),
                })}
                value={inputValue}
                type="text"
                onClick={(e) => {
                  e.stopPropagation();
                }}
                onChange={(e) => {
                  setInputValue(e.target.value);
                  const typed = parseTypedValue(e.target.value);
                  setDate(typed);
                  if (typed) {
                    setMonth(typed);
                  }
                }}
                onBlur={(e) => {
                  if (!containerRef.current?.contains(e.target as Node)) {
                    commit();
                  }
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    commit();
                    e.preventDefault();
                  }
                  if (e.key === 'Escape') {
                    setIsEditing(false);
                    e.preventDefault();
                  }
                }}
                className={cn(
                  'flex-1 h-full min-w-0',
                  'border-none text-sm px-2',
                  'focus:outline-hidden',
                  'placeholder:text-muted-foreground',
                  {
                    'border-transparent bg-transparent!': !isEditing,
                  },
                )}
                autoComplete="off"
              />
            )}
            {!isEditing && (
              <div className="flex grow h-full min-w-0">
                {getFormattedDate(value)}
              </div>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            month={month}
            onMonthChange={setMonth}
            onSelect={handleSelect}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

export { DateEditor };
