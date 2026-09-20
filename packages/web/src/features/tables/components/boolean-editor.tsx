import { Checkbox } from '@/components/ui/checkbox';

import { useCellContext } from './cell-context';

// Tri-state: an empty stored value renders as indeterminate rather than unchecked, since
// "unset" and "explicitly false" are different values on the wire ('' vs 'false'). Radix
// resolves a click on an indeterminate checkbox to `true`, which matches the desired
// first-click affordance without any extra state tracking here.
const BooleanEditor = () => {
  const { value, handleCellChange, disabled } = useCellContext();
  const checked = value === '' ? 'indeterminate' : value === 'true';

  return (
    <div className="h-full w-full flex items-center justify-center">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => {
          if (next === 'indeterminate') {
            return;
          }
          handleCellChange(next ? 'true' : 'false');
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
};
BooleanEditor.displayName = 'BooleanEditor';
export { BooleanEditor };
