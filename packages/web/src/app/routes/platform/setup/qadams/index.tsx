import { QadamMetadataModelSummary } from '@aiqadam/qadams-framework';
import { QadamScope } from '@aiqadam/shared';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import { CheckIcon, Package, Hash, GitBranch, Puzzle } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { DashboardPageHeader } from '@/app/components/dashboard-page-header';
import { ComingSoonBadge } from '@/app/components/request-trial';
import { ApplyTags } from '@/app/routes/platform/setup/qadams/apply-tags';
import { PieceActions } from '@/app/routes/platform/setup/qadams/qadam-actions';
import { SyncPiecesButton } from '@/app/routes/platform/setup/qadams/sync-qadams';
import { DataTable, RowDataWithActions } from '@/components/custom/data-table';
import { DataTableColumnHeader } from '@/components/custom/data-table/data-table-column-header';
import { LockedAlert } from '@/components/custom/locked-alert';
import { Badge } from '@/components/ui/badge';
import { InstallQadamDialog, QadamIcon, qadamsHooks } from '@/features/qadams';
import { platformHooks } from '@/hooks/platform-hooks';

const PlatformPiecesPage = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  const isEnabled = platform.plan.managePiecesEnabled;
  const [searchParams] = useSearchParams();
  const searchQuery = searchParams.get('name') ?? '';
  const {
    qadams,
    refetch: refetchQadams,
    isLoading,
  } = qadamsHooks.useQadams({
    searchQuery,
    includeTags: true,
    includeHidden: true,
    isTableQuery: true,
  });

  const columns: ColumnDef<RowDataWithActions<QadamMetadataModelSummary>>[] =
    useMemo(
      () => [
        {
          accessorKey: 'displayName',
          size: 300,
          header: ({ column }) => (
            <DataTableColumnHeader
              column={column}
              title={t('Name')}
              icon={Puzzle}
            />
          ),
          cell: ({ row }) => {
            return (
              <div className="flex items-center gap-2">
                <QadamIcon
                  size={'sm'}
                  border={true}
                  displayName={row.original.displayName}
                  logoUrl={row.original.logoUrl}
                  showTooltip={false}
                />
                <div className="flex flex-col gap-0.5">
                  <span>{row.original.displayName}</span>
                  {row.original.tags && row.original.tags.length > 0 && (
                    <div className="flex gap-1">
                      {row.original.tags.map((tag) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="text-xs py-0 px-1.5"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          },
        },
        {
          accessorKey: 'packageName',
          size: 250,
          header: ({ column }) => (
            <DataTableColumnHeader
              column={column}
              title={t('Package Name')}
              icon={Hash}
            />
          ),
          cell: ({ row }) => {
            return <div className="text-left">{row.original.name}</div>;
          },
        },
        {
          accessorKey: 'version',
          size: 80,
          header: ({ column }) => (
            <DataTableColumnHeader
              column={column}
              title={t('Version')}
              icon={GitBranch}
            />
          ),
          cell: ({ row }) => {
            return <div className="text-left">{row.original.version}</div>;
          },
        },
        {
          id: 'actions',
          size: 80,
          cell: ({ row }) => {
            return (
              <div className="flex justify-end">
                <PieceActions
                  qadamName={row.original.name}
                  isEnabled={isEnabled}
                />
              </div>
            );
          },
        },
      ],
      [],
    );

  return (
    <>
      <DashboardPageHeader
        description={t('Manage the qadams that are available to your users')}
        title={t('Qadams')}
      />
      <div className="mx-auto w-full flex flex-col flex-1 min-h-0">
        {!isEnabled && (
          <LockedAlert
            title={t('Control Qadams')}
            description={t(
              "Show the qadams that matter most to your users and hide the ones you don't like.",
            )}
            button={<ComingSoonBadge />}
          />
        )}
        <DataTable
          emptyStateTextTitle={t('No qadams found')}
          emptyStateTextDescription={t(
            'Start by installing qadams that you want to use in your automations',
          )}
          emptyStateIcon={<Package className="size-14" />}
          columns={columns}
          filters={[
            {
              type: 'input',
              title: t('Qadam Name'),
              accessorKey: 'name',
              icon: CheckIcon,
            },
          ]}
          page={{
            data: qadams ?? [],
            next: null,
            previous: null,
          }}
          isLoading={isLoading}
          bulkActions={[
            {
              render: (selectedRows) => (
                <ApplyTags
                  selectedQadams={selectedRows}
                  onApplyTags={() => refetchQadams()}
                />
              ),
            },
          ]}
          toolbarButtons={[
            <SyncPiecesButton key="sync" />,
            <InstallQadamDialog
              key="install"
              onInstallPiece={() => refetchQadams()}
              scope={QadamScope.PLATFORM}
            />,
          ]}
          selectColumn={true}
          virtualizeRows={true}
          hidePagination={true}
        />
      </div>
    </>
  );
};

PlatformPiecesPage.displayName = 'PlatformPiecesPage';
export { PlatformPiecesPage };
