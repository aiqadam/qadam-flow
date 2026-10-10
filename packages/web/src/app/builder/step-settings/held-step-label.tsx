import { flowQadamUtil, QadamAction, QadamTrigger } from '@aiqadam/shared';
import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { qadamsHooks } from '@/features/qadams';
import { cn } from '@/lib/utils';

type HeldStepLabelProps = {
  step: QadamAction | QadamTrigger;
  flowId: string;
};

// ADR-0004 "Following `main`": a person reverted a move of this step, so `follow` holds it — it is
// not moved again until the step's version changes. The hold is a `qadam_pin_move` record with
// status `REVERTED`, matched here the same way the server builds its `heldKey`: step name, qadam
// name and the version the reverted step sits on (`fromVersion`). Informational and never blocking:
// it only tells the person why this step stopped following the image.
export function HeldStepLabel({ step, flowId }: HeldStepLabelProps) {
  const { t } = useTranslation();
  const { heldPinMoves } = qadamsHooks.useHeldPinMoves(flowId);
  const exactVersion = flowQadamUtil.getExactVersion(
    step.settings.qadamVersion,
  );
  const isHeld = (heldPinMoves ?? []).some(
    (move) =>
      move.stepName === step.name &&
      move.qadamName === step.settings.qadamName &&
      move.fromVersion === exactVersion,
  );
  if (!isHeld) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <Lock className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Held step')}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          'A version change for this step was reverted, so a publish will not move it again until you change its version.',
        )}
      </p>
    </div>
  );
}
