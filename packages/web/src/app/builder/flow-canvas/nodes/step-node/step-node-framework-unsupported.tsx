import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { qadamsHooks } from '@/features/qadams';

import { useBuilderStateContext } from '../../../builder-hooks';

// ADR-0002 (#803): marks a step whose qadam was built for a framework version this release no
// longer runs. Informational on the canvas; the sidebar says what to do.
export function ApStepNodeFrameworkUnsupported({
  stepName,
}: {
  stepName: string;
}) {
  const { t } = useTranslation();
  const [flowId, flowVersionId, flowVersionUpdated] = useBuilderStateContext(
    (state) => [
      state.flowVersion.flowId,
      state.flowVersion.id,
      state.flowVersion.updated,
    ],
  );
  const { unsupportedStepNames } = qadamsHooks.useUnsupportedFrameworkSteps({
    flowId,
    flowVersionId,
    flowVersionUpdated,
  });
  if (!(unsupportedStepNames ?? []).includes(stepName)) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="absolute top-1 right-1 z-10">
          <TriangleAlert
            className="size-4 text-destructive"
            aria-label={t('Framework version no longer supported')}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {t('Framework version no longer supported')}
      </TooltipContent>
    </Tooltip>
  );
}
