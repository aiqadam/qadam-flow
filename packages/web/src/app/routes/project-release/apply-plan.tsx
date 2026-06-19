import { DiffReleaseRequest } from '@aiqadam/shared';
import { useState, ReactNode } from 'react';

import { Button, ButtonProps } from '@/components/ui/button';
import { projectReleaseMutations } from '@/features/project-releases';

import { CreateReleaseDialog } from './create-release-dialog';

type ApplyButtonProps = ButtonProps & {
  request: DiffReleaseRequest;
  children: ReactNode;
  onSuccess: () => void;
  defaultName?: string;
};

export const ApplyButton = ({
  request,
  children,
  onSuccess,
  defaultName,
  ...props
}: ApplyButtonProps) => {
  const [isCreateReleaseDialogOpen, setIsCreateReleaseDialogOpen] =
    useState(false);
  const [syncPlan, setSyncPlan] = useState<any>(null);
  const [loadingRequestId, setLoadingRequestId] = useState<string | null>(null);

  const { mutate: loadSyncPlan } = projectReleaseMutations.useDiffRelease({
    onSuccess: (plan) => {
      if (
        (!plan.flows || plan.flows.length === 0) &&
        (!plan.tables || plan.tables.length === 0)
      ) {
        setSyncPlan(null);
        setLoadingRequestId(null);
        return;
      }
      setSyncPlan(plan);
      setLoadingRequestId(null);
    },
    onError: () => {
      setSyncPlan(null);
      setLoadingRequestId(null);
    },
  });

  const requestId = JSON.stringify(request);
  const isLoading = loadingRequestId === requestId;

  return (
    <>
      <Button
        {...props}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setLoadingRequestId(requestId);
          setIsCreateReleaseDialogOpen(true);
          loadSyncPlan(request);
        }}
      >
        {children}
      </Button>

      {isCreateReleaseDialogOpen && (
        <CreateReleaseDialog
          open={isCreateReleaseDialogOpen}
          loading={isLoading}
          setOpen={setIsCreateReleaseDialogOpen}
          refetch={onSuccess}
          plan={syncPlan}
          defaultName={defaultName}
          diffRequest={request}
        />
      )}
    </>
  );
};
