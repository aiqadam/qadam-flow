import { UserStatus, UserWithMetaInformation } from '@aiqadam/shared';
import { t } from 'i18next';
import { User } from 'lucide-react';
import { useMemo } from 'react';

import { DashboardPageHeader } from '@/app/components/dashboard-page-header';
import LockedFeatureGuard from '@/app/components/locked-feature-guard';
import { DataTable } from '@/components/custom/data-table';
import {
  platformUserHooks,
  platformUserMutations,
} from '@/features/platform-admin/hooks/platform-user-hooks';

import { UserActions } from './actions/user-actions';
import { createUsersTableColumns } from './columns';

export default function UsersPage() {
  const {
    data: usersData,
    isLoading: usersLoading,
    refetch: refetchUsers,
  } = platformUserHooks.useUsers();

  const refetch = () => {
    refetchUsers();
  };

  const combinedData: UserRowData[] = useMemo(() => {
    return (
      usersData?.data?.map((user) => ({
        id: user.id,
        type: 'user' as const,
        data: user,
      })) ?? []
    );
  }, [usersData]);

  const { mutate: deleteUser } = platformUserMutations.useDeleteUser({
    onSuccess: refetch,
  });

  const { mutate: updateUserStatus, isPending: isUpdatingStatus } =
    platformUserMutations.useUpdateUserStatus({ onSuccess: refetch });

  const handleDelete = (id: string) => {
    deleteUser(id);
  };

  const handleToggleStatus = (userId: string, currentStatus: UserStatus) => {
    updateUserStatus({
      userId,
      status:
        currentStatus === UserStatus.ACTIVE
          ? UserStatus.INACTIVE
          : UserStatus.ACTIVE,
    });
  };

  const columns = createUsersTableColumns();

  return (
    <LockedFeatureGuard
      locked={false}
      lockTitle={t('Users')}
      lockDescription={t('Manage your users and their access to your projects')}
    >
      <div className="flex flex-col w-full">
        <DashboardPageHeader
          title={t('Users')}
          description={t(
            'Manage, delete, activate and deactivate users on platform',
          )}
        />
        <DataTable
          emptyStateTextTitle={t('No users found')}
          emptyStateTextDescription={t('No users on this platform yet')}
          emptyStateIcon={<User className="size-14" />}
          columns={columns}
          page={{
            data: combinedData,
            next: usersData?.next || null,
            previous: usersData?.previous || null,
          }}
          hidePagination={true}
          isLoading={usersLoading}
          actions={[
            (row) => (
              <UserActions
                row={row}
                isUpdatingStatus={isUpdatingStatus}
                onDelete={handleDelete}
                onToggleStatus={handleToggleStatus}
                onUpdate={refetch}
              />
            ),
          ]}
        />
      </div>
    </LockedFeatureGuard>
  );
}

export type UserRowData = {
  id: string;
  type: 'user';
  data: UserWithMetaInformation;
};
