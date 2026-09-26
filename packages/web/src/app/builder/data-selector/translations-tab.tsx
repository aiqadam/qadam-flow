import { Permission } from '@aiqadam/shared';
import { t } from 'i18next';
import { Languages, Plus, SearchXIcon } from 'lucide-react';
import { useState } from 'react';
import { useDebounce } from 'use-debounce';

import { TranslationKeyDialog } from '@/app/translations/translation-key-dialog';
import { SearchInput } from '@/components/custom/search-input';
import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { projectCollectionUtils } from '@/features/projects';
import { translationsQueries } from '@/features/translations/hooks/translations-hooks';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { authenticationSession } from '@/lib/authentication-session';
import { cn } from '@/lib/utils';

import { useBuilderStateContext } from '../builder-hooks';

const TranslationsTab = () => {
  const insertMention = useBuilderStateContext((state) => state.insertMention);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebounce(search, 250);
  const [createOpen, setCreateOpen] = useState(false);
  const projectId = authenticationSession.getProjectId();
  const { checkAccess } = useAuthorization();
  const canRead = checkAccess(Permission.READ_TRANSLATION);
  const canWrite = checkAccess(Permission.WRITE_TRANSLATION);
  const { project } = projectCollectionUtils.useCurrentProject();

  const { data, isLoading, refetch } = translationsQueries.useTranslations({
    request: {
      projectId: projectId ?? '',
      limit: 50,
      key: debouncedSearch || undefined,
    },
    extraKeys: ['data-selector-translations', projectId ?? '', debouncedSearch],
    enabled: !!projectId && canRead,
  });

  const translations = data?.data ?? [];

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2 px-5">
        <SearchInput
          onChange={setSearch}
          value={search}
          placeholder={t('Search translation keys')}
        />
        {canWrite && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-4 h-4" />
            {t('New')}
          </Button>
        )}
      </div>

      <ScrollArea className="transition-all flex-1 w-full">
        {isLoading && (
          <div className="text-center text-sm text-muted-foreground py-8">
            {t('Loading…')}
          </div>
        )}

        {!isLoading && translations.length === 0 && (
          <div className="flex items-center justify-center gap-2 mt-5 flex-col px-6">
            {debouncedSearch ? (
              <>
                <SearchXIcon className="w-[35px] h-[35px]" />
                <div className="text-center font-semibold text-md">
                  {t('No matching translation keys')}
                </div>
                <div className="text-center text-sm text-muted-foreground">
                  {t('Try adjusting your search')}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 text-primary">
                  <Languages className="w-5 h-5" />
                </div>
                <div className="text-center font-semibold text-md">
                  {t('No translation keys yet')}
                </div>
                <div className="text-center text-sm text-muted-foreground max-w-[280px]">
                  {t(
                    'Create a translation key to reference it from any flow input.',
                  )}
                </div>
                {canWrite && (
                  <Button
                    type="button"
                    size="sm"
                    className="mt-2 gap-1.5"
                    onClick={() => setCreateOpen(true)}
                  >
                    <Plus className="w-4 h-4" />
                    {t('New translation key')}
                  </Button>
                )}
              </>
            )}
          </div>
        )}

        {!isLoading && translations.length > 0 && (
          <div className="flex flex-col">
            {translations.map((translation) => (
              <div
                key={translation.id}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    if (insertMention) {
                      insertMention(`$t['${translation.key}']`);
                    }
                  }
                }}
                onClick={() => {
                  if (insertMention) {
                    insertMention(`$t['${translation.key}']`);
                  }
                }}
                className={cn(
                  'group w-full max-w-full select-none focus:outline-hidden',
                  'hover:bg-accent dark:hover:bg-accent/20 focus:bg-accent focus:bg-opacity-75',
                  'cursor-pointer flex items-center gap-3 px-5 py-3',
                )}
              >
                <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-md bg-primary/10 text-primary">
                  <Languages className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <TextWithTooltip tooltipMessage={translation.key}>
                    <div className="font-mono text-sm truncate">
                      {translation.key}
                    </div>
                  </TextWithTooltip>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>

      <TranslationKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultLocale={project.defaultLocale}
        onSaved={() => refetch()}
      />
    </div>
  );
};

TranslationsTab.displayName = 'TranslationsTab';
export { TranslationsTab };
