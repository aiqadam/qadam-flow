import { ResponseApiKey } from '@aiqadam/shared';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import { KeyRound, Trash } from 'lucide-react';

import { DashboardPageHeader } from '@/app/components/dashboard-page-header';
import { DataTable, RowDataWithActions } from '@/components/custom/data-table';
import { DataTableColumnHeader } from '@/components/custom/data-table/data-table-column-header';
import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { FormattedDate } from '@/components/custom/formatted-date';
import { Button } from '@/components/ui/button';
import { CreateApiKeyDialog } from '@/features/api-keys/components/create-api-key-dialog';
import {
  apiKeysHooks,
  apiKeysMutations,
} from '@/features/api-keys/hooks/api-keys-hooks';

const columns: (ColumnDef<RowDataWithActions<ResponseApiKey>> & {
  accessorKey: string;
})[] = [
  {
    accessorKey: 'displayName',
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Name')}
        icon={KeyRound}
      />
    ),
    cell: ({ row }) => <div>{row.original.displayName}</div>,
  },
  {
    accessorKey: 'truncatedValue',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={t('Key')} />
    ),
    cell: ({ row }) => (
      <div className="font-mono text-muted-foreground">
        {`sk-••••${row.original.truncatedValue}`}
      </div>
    ),
  },
  {
    accessorKey: 'created',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={t('Created')} />
    ),
    cell: ({ row }) => <FormattedDate date={new Date(row.original.created)} />,
  },
];

export default function ApiKeysPage() {
  const { data, isLoading } = apiKeysHooks.useList();
  const { mutateAsync: deleteApiKey } = apiKeysMutations.useDelete();

  return (
    <div className="flex flex-col w-full">
      <DashboardPageHeader
        title={t('API Keys')}
        description={t(
          'Manage API keys used to authenticate requests to the API',
        )}
      >
        <CreateApiKeyDialog />
      </DashboardPageHeader>
      <DataTable
        emptyStateTextTitle={t('No API keys found')}
        emptyStateTextDescription={t(
          'Create your first API key to get started',
        )}
        emptyStateIcon={<KeyRound className="size-14" />}
        columns={columns}
        page={{
          data: data?.data ?? [],
          next: data?.next || null,
          previous: data?.previous || null,
        }}
        hidePagination={true}
        isLoading={isLoading}
        actions={[
          (row) => (
            <ConfirmationDeleteDialog
              title={t('Delete API key')}
              message={t(
                'This API key will be permanently deleted. Any request using it will stop working.',
              )}
              entityName={row.displayName}
              mutationFn={() => deleteApiKey(row.id)}
            >
              <Button variant="ghost" size="icon">
                <Trash className="size-4 text-destructive" />
              </Button>
            </ConfirmationDeleteDialog>
          ),
        ]}
      />
    </div>
  );
}
