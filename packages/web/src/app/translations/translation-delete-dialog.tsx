import { Translation } from '@aiqadam/shared';
import { t } from 'i18next';

import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { translationsApi } from '@/features/translations/api/translations';
import { translationsQueries } from '@/features/translations/hooks/translations-hooks';

type TranslationDeleteDialogProps = {
  translation: Translation | undefined;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
};

function TranslationDeleteDialog({
  translation,
  onOpenChange,
  onDeleted,
}: TranslationDeleteDialogProps) {
  const { data: usages, isLoading } = translationsQueries.useUsages(
    translation?.id,
  );

  const referencingFlows = (usages?.usages ?? []).filter(
    (usage) => usage.referencedInDraft || usage.referencedInPublished,
  );

  return (
    <ConfirmationDeleteDialog
      title={t('Delete translation key')}
      message={t(
        'This permanently deletes the translation key. Flows that reference it will fail at runtime.',
      )}
      entityName={translation?.key ?? ''}
      isDanger
      showToast
      open={!!translation}
      onOpenChange={onOpenChange}
      warning={
        !isLoading && referencingFlows.length > 0 ? (
          <div className="flex flex-col gap-1">
            <span>
              {t(
                'Still referenced by {count, plural, =1 {1 flow} other {# flows}}:',
                {
                  count: referencingFlows.length,
                },
              )}
            </span>
            <ul className="list-disc pl-4">
              {referencingFlows.map((usage) => (
                <li key={usage.flowId}>{usage.flowDisplayName}</li>
              ))}
            </ul>
            {usages?.truncated && (
              <span className="text-xs">
                {t(
                  'More flows may reference this key — the scan stopped early.',
                )}
              </span>
            )}
          </div>
        ) : undefined
      }
      mutationFn={async () => {
        if (!translation) return;
        await translationsApi.delete(translation.id);
        onDeleted();
      }}
    />
  );
}

export { TranslationDeleteDialog };
