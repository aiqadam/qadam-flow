import { PlatformRole, UserStatus } from '@aiqadam/shared';
import { ColumnDef } from '@tanstack/react-table';
import { t } from 'i18next';
import {
  Tag,
  Fingerprint,
  Shield,
  Clock,
  Activity,
  Mail,
  Hash,
} from 'lucide-react';

import { RowDataWithActions } from '@/components/custom/data-table';
import { DataTableColumnHeader } from '@/components/custom/data-table/data-table-column-header';
import { TruncatedColumnTextValue } from '@/components/custom/data-table/truncated-column-text-value';
import { FormattedDate } from '@/components/custom/formatted-date';

import { UserRowData } from './index';

type ColumnDefWithAccessorKey = ColumnDef<RowDataWithActions<UserRowData>> & {
  accessorKey: string;
};

export const createUsersTableColumns = (): ColumnDefWithAccessorKey[] => [
  {
    accessorKey: 'identity',
    size: 320,
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Identity')}
        icon={Fingerprint}
      />
    ),
    cell: ({ row }) => {
      const externalId = row.original.data.externalId;
      const email = row.original.data.email;
      const showEmail = email?.includes('@');

      return (
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-0.5">
            {showEmail && (
              <div className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <TruncatedColumnTextValue
                  value={email}
                  className="max-w-[200px] 2xl:max-w-[280px]"
                />
              </div>
            )}
            {externalId && (
              <div className="flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <TruncatedColumnTextValue
                  value={externalId}
                  className="max-w-[200px] 2xl:max-w-[280px]"
                />
              </div>
            )}
            {!showEmail && !externalId && (
              <span className="text-muted-foreground">-</span>
            )}
          </div>
        </div>
      );
    },
  },
  {
    accessorKey: 'name',
    size: 210,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={t('Name')} icon={Tag} />
    ),
    cell: ({ row }) => {
      return (
        <TruncatedColumnTextValue
          value={row.original.data.firstName + ' ' + row.original.data.lastName}
          className="max-w-[160px] 2xl:max-w-[200px]"
        />
      );
    },
  },
  {
    accessorKey: 'role',
    size: 90,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={t('Role')} icon={Shield} />
    ),
    cell: ({ row }) => {
      const platformRole = row.original.data.platformRole;
      return (
        <div className="text-left">
          {platformRole === PlatformRole.ADMIN
            ? t('Admin')
            : platformRole === PlatformRole.OPERATOR
            ? t('Operator')
            : t('Member')}
        </div>
      );
    },
  },
  {
    accessorKey: 'createdAt',
    size: 130,
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Created')}
        icon={Clock}
      />
    ),
    cell: ({ row }) => {
      return (
        <div className="text-left">
          <FormattedDate date={new Date(row.original.data.created)} />
        </div>
      );
    },
  },
  {
    accessorKey: 'lastActiveDate',
    size: 130,
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Last Active')}
        icon={Clock}
      />
    ),
    cell: ({ row }) => {
      return row.original.data.lastActiveDate ? (
        <div className="text-left">
          <FormattedDate date={new Date(row.original.data.lastActiveDate)} />
        </div>
      ) : (
        '-'
      );
    },
  },
  {
    accessorKey: 'status',
    size: 100,
    header: ({ column }) => (
      <DataTableColumnHeader
        column={column}
        title={t('Status')}
        icon={Activity}
      />
    ),
    cell: ({ row }) => {
      return (
        <div className="text-left">
          {row.original.data.status === UserStatus.ACTIVE
            ? t('Activated')
            : t('Deactivated')}
        </div>
      );
    },
  },
];
