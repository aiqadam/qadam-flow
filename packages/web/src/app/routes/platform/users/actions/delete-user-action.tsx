import { t } from 'i18next';
import { Trash } from 'lucide-react';

import { ConfirmationDeleteDialog } from '@/components/custom/delete-dialog';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import { UserRowData } from '../index';

type DeleteUserActionProps = {
  row: UserRowData;
  isDeleting: boolean;
  onDelete: (id: string) => void;
};

export const DeleteUserAction = ({
  row,
  isDeleting,
  onDelete,
}: DeleteUserActionProps) => {
  const email = row.data.email;

  return (
    <div className="flex items-end justify-end">
      <Tooltip>
        <TooltipTrigger>
          <ConfirmationDeleteDialog
            title={t('Delete User')}
            message={t(
              'This user and all their data will be permanently deleted.',
            )}
            entityName={`${t('User')} ${email}`}
            buttonText={t('Delete')}
            mutationFn={async () => {
              onDelete(row.data.id);
            }}
          >
            <Button loading={isDeleting} variant="ghost" className="size-8 p-0">
              <Trash className="size-4 text-destructive" />
            </Button>
          </ConfirmationDeleteDialog>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('Delete user')}</TooltipContent>
      </Tooltip>
    </div>
  );
};
