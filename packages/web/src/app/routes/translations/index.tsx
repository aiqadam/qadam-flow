import { Permission, Translation } from '@aiqadam/shared';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import {
  Download,
  Languages,
  MoreVertical,
  Pencil,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import { ImportTranslationsDialog } from '@/app/translations/import-translations-dialog';
import { TranslationDeleteDialog } from '@/app/translations/translation-delete-dialog';
import { TranslationKeyDialog } from '@/app/translations/translation-key-dialog';
import { TranslationValueCell } from '@/app/translations/translation-value-cell';
import {
  BulkAction,
  CURSOR_QUERY_PARAM,
  DataTable,
  DataTableFilters,
  RowDataWithActions,
} from '@/components/custom/data-table';
import { DataTableInputCheckbox } from '@/components/custom/data-table/data-table-checkbox-filter';
import { DataTableColumnHeader } from '@/components/custom/data-table/data-table-column-header';
import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { PermissionNeededTooltip } from '@/components/custom/permission-needed-tooltip';
import { TextWithTooltip } from '@/components/custom/text-with-tooltip';
import { PlusIcon } from '@/components/icons/plus';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { projectCollectionUtils } from '@/features/projects';
import { translationsApi } from '@/features/translations/api/translations';
import {
  translationsMutations,
  translationsQueries,
} from '@/features/translations/hooks/translations-hooks';
import { useAuthorization } from '@/hooks/authorization-hooks';
import { authenticationSession } from '@/lib/authentication-session';

const exportLocale = async (locale: string) => {
  const projectId = authenticationSession.getProjectId();
  if (!projectId) return;
  const { translations } = await translationsApi.exportAll({
    projectId,
    locale,
  });
  const blob = new Blob([JSON.stringify(translations, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${locale}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

const isRowMissingAValue = ({
  translation,
  presentLocales,
  defaultLocale,
}: {
  translation: Translation;
  presentLocales: string[];
  defaultLocale: string | null | undefined;
}) => {
  const requiredLocales = defaultLocale
    ? [...new Set([...presentLocales, defaultLocale])]
    : presentLocales;
  return requiredLocales.some((locale) => !translation.values[locale]);
};

function TranslationsPage() {
  const projectId = authenticationSession.getProjectId()!;
  const { checkAccess } = useAuthorization();
  const canWrite = checkAccess(Permission.WRITE_TRANSLATION);
  const { project } = projectCollectionUtils.useCurrentProject();

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Translation | undefined>(undefined);
  const [deleting, setDeleting] = useState<Translation | undefined>(undefined);
  const [selectedRows, setSelectedRows] = useState<Translation[]>([]);
  const [showBulkDeleteDialog, setShowBulkDeleteDialog] = useState(false);

  const { cursor, limit, key, missing } =
    translationsQueries.useListSearchParams();
  const [, setSearchParams] = useSearchParams();
  const toggleMissingFilter = (checked: boolean) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(CURSOR_QUERY_PARAM);
        if (checked) {
          next.set('missing', 'true');
        } else {
          next.delete('missing');
        }
        return next;
      },
      { replace: true },
    );
  };

  const {
    data: translations,
    isLoading,
    refetch,
  } = translationsQueries.useTranslations({
    request: { projectId, cursor, limit, key },
    extraKeys: [
      'translations',
      cursor ?? '',
      String(limit),
      key ?? '',
      projectId,
    ],
    showErrorDialog: true,
  });

  const { mutateAsync: deleteTranslations } =
    translationsMutations.useBulkDeleteTranslations(refetch);

  const presentLocales = useMemo(() => {
    const locales = new Set<string>();
    (translations?.data ?? []).forEach((translation) => {
      Object.keys(translation.values).forEach((locale) => locales.add(locale));
    });
    if (project.defaultLocale) {
      locales.add(project.defaultLocale);
    }
    return Array.from(locales).sort((a, b) =>
      a === project.defaultLocale
        ? -1
        : b === project.defaultLocale
        ? 1
        : a.localeCompare(b),
    );
  }, [translations, project.defaultLocale]);

  const filteredData = useMemo(() => {
    if (!translations?.data) return undefined;
    if (!missing) return translations;
    return {
      data: translations.data.filter((translation) =>
        isRowMissingAValue({
          translation,
          presentLocales,
          defaultLocale: project.defaultLocale,
        }),
      ),
      next: translations.next,
      previous: translations.previous,
    };
  }, [translations, missing, presentLocales, project.defaultLocale]);

  const filters: DataTableFilters<'key'>[] = [
    {
      type: 'input',
      title: t('Key'),
      accessorKey: 'key',
      icon: Search,
    },
  ];

  const localeColumns: ColumnDef<RowDataWithActions<Translation>, unknown>[] =
    presentLocales.map((locale) => ({
      id: locale,
      size: 220,
      header: () => (
        <div className="flex items-center gap-1.5">
          {locale}
          {locale === project.defaultLocale && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {t('Default')}
            </Badge>
          )}
        </div>
      ),
      cell: ({ row }) => (
        <TranslationValueCell
          translation={row.original}
          locale={locale}
          canWrite={canWrite}
          onSaved={() => refetch()}
        />
      ),
    }));

  const columns: ColumnDef<RowDataWithActions<Translation>, unknown>[] = [
    {
      accessorKey: 'key',
      size: 260,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('Key')}
          icon={Languages}
        />
      ),
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="font-mono text-sm truncate">{row.original.key}</span>
          {row.original.description && (
            <TextWithTooltip tooltipMessage={row.original.description}>
              <p className="text-xs text-muted-foreground truncate">
                {row.original.description}
              </p>
            </TextWithTooltip>
          )}
        </div>
      ),
    },
    ...localeColumns,
    {
      id: 'actions',
      size: 60,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('Open menu')}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                disabled={!canWrite}
                onSelect={(e) => {
                  e.preventDefault();
                  setEditing(row.original);
                }}
              >
                <Pencil className="h-4 w-4 mr-2" />
                {t('Edit')}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canWrite}
                className="text-destructive focus:text-destructive"
                onSelect={(e) => {
                  e.preventDefault();
                  setDeleting(row.original);
                }}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t('Delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  const bulkActions: BulkAction<Translation>[] = useMemo(
    () => [
      {
        render: (_rows, resetSelection) => (
          <>
            {selectedRows.length > 0 && (
              <ConfirmationDeleteDialog
                title={t('Delete translation keys')}
                message={t(
                  'This permanently deletes the selected translation keys. Flows that reference them will fail at runtime.',
                )}
                entityName={t('translation key')}
                buttonText={t('Delete')}
                isDanger
                showToast
                open={showBulkDeleteDialog}
                onOpenChange={setShowBulkDeleteDialog}
                mutationFn={async () => {
                  await deleteTranslations(selectedRows.map((row) => row.id));
                  resetSelection();
                  setSelectedRows([]);
                }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={!canWrite}
                  onClick={() => setShowBulkDeleteDialog(true)}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t('Delete')} ({selectedRows.length})
                </Button>
              </ConfirmationDeleteDialog>
            )}
          </>
        ),
      },
    ],
    [selectedRows, showBulkDeleteDialog, canWrite, deleteTranslations],
  );

  const toolbarButtons = [
    <ImportTranslationsDialog
      key="import"
      onImported={(result) => {
        toast.success(
          t('{count, plural, =1 {1 key imported} other {# keys imported}}', {
            count: result.importedKeys,
          }),
        );
        refetch();
      }}
    >
      <PermissionNeededTooltip hasPermission={canWrite}>
        <Button disabled={!canWrite} size="sm" variant="outline">
          <Upload className="h-4 w-4 mr-1" />
          {t('Import')}
        </Button>
      </PermissionNeededTooltip>
    </ImportTranslationsDialog>,
    <DropdownMenu key="export">
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={presentLocales.length === 0}
        >
          <Download className="h-4 w-4 mr-1" />
          {t('Export')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {presentLocales.map((locale) => (
          <DropdownMenuItem key={locale} onClick={() => exportLocale(locale)}>
            {locale}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>,
    <PermissionNeededTooltip key="new" hasPermission={canWrite}>
      <Button
        disabled={!canWrite}
        size="sm"
        onClick={() => setCreateOpen(true)}
      >
        <PlusIcon size={16} className="mr-1" />
        {t('New key')}
      </Button>
    </PermissionNeededTooltip>,
  ];

  return (
    <div className="flex flex-col w-full">
      <DataTable
        emptyStateTextTitle={t('No translation keys yet')}
        emptyStateTextDescription={t(
          'Create one to reference it from any flow input using the $t mention.',
        )}
        emptyStateIcon={<Languages className="size-14" />}
        columns={columns}
        page={filteredData}
        isLoading={isLoading}
        filters={filters}
        customFilters={[
          <DataTableInputCheckbox
            key="missing"
            label={t('Missing a value')}
            checked={missing}
            handleCheckedChange={toggleMissingFilter}
          />,
        ]}
        toolbarButtons={toolbarButtons}
        selectColumn={true}
        onSelectedRowsChange={setSelectedRows}
        bulkActions={bulkActions}
      />
      <TranslationKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultLocale={project.defaultLocale}
        onSaved={() => refetch()}
      />
      <TranslationKeyDialog
        open={!!editing}
        existing={editing}
        defaultLocale={project.defaultLocale}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined);
          }
        }}
        onSaved={() => {
          refetch();
          setEditing(undefined);
        }}
      />
      <TranslationDeleteDialog
        translation={deleting}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(undefined);
          }
        }}
        onDeleted={() => {
          refetch();
          setDeleting(undefined);
        }}
      />
    </div>
  );
}

export { TranslationsPage };
