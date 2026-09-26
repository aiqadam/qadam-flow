import { Translation } from '@aiqadam/shared';
import { useState } from 'react';

import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Input } from '@/components/ui/input';
import { translationsMutations } from '@/features/translations/hooks/translations-hooks';
import { authenticationSession } from '@/lib/authentication-session';

type TranslationValueCellProps = {
  translation: Translation;
  locale: string;
  canWrite: boolean;
  onSaved: () => void;
};

function TranslationValueCell({
  translation,
  locale,
  canWrite,
  onSaved,
}: TranslationValueCellProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(translation.values[locale] ?? '');
  const { mutate: save, isPending } = translationsMutations.useUpsertBatch({
    onSuccess: onSaved,
  });

  const startEditing = () => {
    if (!canWrite) return;
    setValue(translation.values[locale] ?? '');
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    const projectId = authenticationSession.getProjectId();
    if (!projectId || value === (translation.values[locale] ?? '')) {
      return;
    }
    save({
      projectId,
      translations: [{ key: translation.key, values: { [locale]: value } }],
    });
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={value}
        disabled={isPending}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setEditing(false);
          }
        }}
        className="h-7 text-sm"
      />
    );
  }

  return (
    <button
      type="button"
      disabled={!canWrite}
      onClick={startEditing}
      className="w-full max-w-[220px] min-w-0 text-left text-sm disabled:cursor-default rounded-sm px-1 enabled:hover:bg-accent"
    >
      {translation.values[locale] ? (
        <TextWithTooltip tooltipMessage={translation.values[locale]}>
          <span className="block truncate">{translation.values[locale]}</span>
        </TextWithTooltip>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </button>
  );
}

export { TranslationValueCell };
