import { QadamAction, QadamTrigger } from '@aiqadam/shared';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { qadamsHooks } from '@/features/qadams';
import { cn } from '@/lib/utils';

type UnavailablePinLabelProps = {
  step: QadamAction | QadamTrigger;
  flowId: string;
  flowVersionId: string;
  flowVersionUpdated: string;
};

// ADR-0003 "Unavailable version" / "Versions that were never published" (#808): the step's pinned
// qadam version is unavailable on this installation and a publish or the snapshot follow pass did
// not move it to the image's build, with the reason (`qadamPinFallbackDecision.StayReason`). The
// server decides (`GET /v1/qadam-pin-moves/check`); this only shows the answer. It marks the step
// and never blocks editing or a run — updating the step is the remedy, and the flow is never
// disabled (#435).
export function UnavailablePinLabel({
  step,
  flowId,
  flowVersionId,
  flowVersionUpdated,
}: UnavailablePinLabelProps) {
  const { t } = useTranslation();
  const stay = qadamsHooks.usePinStayForStep({
    flowId,
    flowVersionId,
    flowVersionUpdated,
    stepName: step.name,
  });
  if (!stay) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <p className="text-sm font-medium">
          {t('Version unavailable — update this step')}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          'This step is pinned to a qadam version that is unavailable on this installation and could not be moved to this build’s version automatically: {detail}. Update this step.',
          { detail: stay.detail },
        )}
      </p>
    </div>
  );
}
