import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { qadamsHooks } from '@/features/qadams';

import { useBuilderStateContext } from '../../../builder-hooks';

// ADR-0003 "Unavailable version" / "Versions that were never published" (#808): marks a step whose
// pinned qadam version is unavailable and was not moved to the image's build automatically.
// Informational on the canvas; the sidebar says what to do.
export function ApStepNodeUnavailablePin({ stepName }: { stepName: string }) {
  const { t } = useTranslation();
  const [flowId, flowVersionId, flowVersionUpdated] = useBuilderStateContext(
    (state) => [
      state.flowVersion.flowId,
      state.flowVersion.id,
      state.flowVersion.updated,
    ],
  );
  const { pinStays } = qadamsHooks.useUnavailablePinStays({
    flowId,
    flowVersionId,
    flowVersionUpdated,
  });
  if (!(pinStays ?? []).some((stay) => stay.stepName === stepName)) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="absolute bottom-1 right-1 z-10">
          <TriangleAlert
            className="size-4 text-destructive"
            aria-label={t('Version unavailable — update this step')}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {t('Version unavailable — update this step')}
      </TooltipContent>
    </Tooltip>
  );
}
