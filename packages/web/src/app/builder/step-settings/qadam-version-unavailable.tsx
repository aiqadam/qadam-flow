import { flowQadamUtil, QadamAction, QadamTrigger } from '@aiqadam/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UpdatePieceVersionDialog } from './update-qadam-version-dialog/update-qadam-version-dialog';

type QadamVersionUnavailableProps = {
  step: QadamAction | QadamTrigger;
  readonly: boolean;
};

export function QadamVersionUnavailable({
  step,
  readonly,
}: QadamVersionUnavailableProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed p-4">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 text-destructive shrink-0" />
        <p className="text-sm font-medium">{t('Piece version unavailable')}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          'This step is pinned to a version of this piece that is no longer available. Update it to the latest version to continue editing this step.',
        )}
      </p>
      {!readonly && (
        <UpdatePieceVersionDialog
          step={step}
          currentVersion={flowQadamUtil.getExactVersion(
            step.settings.qadamVersion,
          )}
          variant="labelled"
        />
      )}
    </div>
  );
}
