import {
  flowQadamUtil,
  isNil,
  QadamAction,
  QadamTrigger,
  qadamVersionParser,
} from '@aiqadam/shared';
import { ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { qadamsHooks } from '@/features/qadams';
import { cn } from '@/lib/utils';

import { UpdatePieceVersionDialog } from './update-qadam-version-dialog/update-qadam-version-dialog';
import { changeVersionUtils } from './update-qadam-version-dialog/update-qadam-version-utils';

type UpdateAvailableLabelProps = {
  step: QadamAction | QadamTrigger;
  readonly: boolean;
};

// ADR-0004 "UX": a snapshot pin (`x.y.z-main.<n>`) runs an unreleased build from `main`. Once the
// instance knows a release of the same qadam inside the pin's caret range, offer it — the graduation
// the ADR describes, where `^1.3.0-main.412` contains the base release `1.3.0` and later patches.
// This is an offer, never a move: nothing rewrites the pin until a person applies it through the
// existing update dialog. `readonly` still shows the fact; only the action is hidden.
export function UpdateAvailableLabel({
  step,
  readonly,
}: UpdateAvailableLabelProps) {
  const { t } = useTranslation();
  const exactVersion = flowQadamUtil.getExactVersion(
    step.settings.qadamVersion,
  );
  const isSnapshot = qadamVersionParser.isSnapshot({ version: exactVersion });
  const { qadamVersions } = qadamsHooks.useQadamVersions(
    step.settings.qadamName,
  );
  const release = isSnapshot
    ? changeVersionUtils.getLatestReleaseInsideCaret({
        pin: step.settings.qadamVersion,
        versions: qadamVersions ?? [],
      })
    : undefined;
  if (isNil(release)) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <ArrowUp className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Update available')}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t('A released version of this Qadam is available: v{version}.', {
          version: release,
        })}
      </p>
      {!readonly && (
        <UpdatePieceVersionDialog
          step={step}
          currentVersion={exactVersion}
          suggestedVersion={release}
          variant="labelled"
        />
      )}
    </div>
  );
}
