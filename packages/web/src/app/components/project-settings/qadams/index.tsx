import { QadamMetadataModelSummary } from '@aiqadam/qadams-framework';
import { QadamType } from '@aiqadam/shared';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import { Package, Trash, Puzzle, Tag, Hash, GitBranch } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ComingSoonBadge } from '@/app/components/request-trial';
import { DataTable, RowDataWithActions } from '@/components/custom/data-table';
import { DataTableColumnHeader } from '@/components/custom/data-table/data-table-column-header';
import { DataTableInputPopover } from '@/components/custom/data-table/data-table-input-popover';
import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { LockedAlert } from '@/components/custom/locked-alert';
import { Button } from '@/components/ui/button';
import { qadamsApi, QadamIcon, qadamsHooks } from '@/features/qadams';
import { platformHooks } from '@/hooks/platform-hooks';

import { ManagePiecesDialog } from './manage-qadams-dialog';

const columns: ColumnDef<RowDataWithActions<QadamMetadataModelSummary>>[] = [
  {
    accessorKey: 'name',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={t('Qadam')} icon={Puzzle} />
    ),
    cell: ({ row }) => {
      return (
        <div className="text-left">
          <QadamIcon
            size={'sm'}
            border={true}
            displayName={row.original.displayName}
            logoUrl={row.original.logoUrl}
            showTooltip={false}
          />
        </div>
      );
    },
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Display Name')}
        icon={Tag}
      />
    ),
    cell: ({ row }) => {
      return <div className="text-left">{row.original.displayName}</div>;
    },
  },
  {
    accessorKey: 'packageName',
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
    accessorKey: 'actions',
    header: ({ column }) => <DataTableColumnHeader column={column} title="" />,
    cell: ({ row }) => {
      if (row.original.qadamType !== QadamType.CUSTOM) {
        return null;
      }
      return (
        <ConfirmationDeleteDialog
          title={t('Delete {name}', { name: row.original.name })}
          entityName={t('Qadam')}
          message={t(
            'This will permanently delete this qadam, all steps using it will fail.',
          )}
          mutationFn={async () => {
            row.original.delete();
            await qadamsApi.delete(row.original.id!);
          }}
        >
          <div className="flex items-end justify-end">
            <Button variant="ghost" className="size-8 p-0">
              <Trash className="size-4 text-destructive" />
            </Button>
          </div>
        </ConfirmationDeleteDialog>
      );
    },
  },
];

const PiecesSettings = () => {
  const { platform } = platformHooks.useCurrentPlatform();
  const [searchQuery, setSearchQuery] = useState('');
  const { qadams, isLoading, refetch } = qadamsHooks.useQadams({
    searchQuery,
    isTableQuery: true,
  });

  const toolbarButtons = useMemo(
    () => [<ManagePiecesDialog key="manage" onSuccess={() => refetch()} />],
    [refetch],
  );

  const customFilters = useMemo(
    () => [
      <DataTableInputPopover
        key="search"
        title={t('Qadam Name')}
        filterValue={searchQuery}
        handleFilterChange={setSearchQuery}
      />,
    ],
    [searchQuery],
  );

  return (
    <div className="space-y-6">
      {!platform.plan.managePiecesEnabled && (
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
          'Add a qadam to your project that you want to use in your automations',
        )}
        emptyStateIcon={<Package className="size-14" />}
        columns={columns}
        customFilters={customFilters}
        page={{
          data: qadams ?? [],
          next: null,
          previous: null,
        }}
        isLoading={isLoading}
        hidePagination={true}
        toolbarButtons={platform.plan.managePiecesEnabled ? toolbarButtons : []}
      />
    </div>
  );
};

PiecesSettings.displayName = 'PiecesSettings';
export { PiecesSettings };
