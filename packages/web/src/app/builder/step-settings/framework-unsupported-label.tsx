import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { qadamsHooks } from '@/features/qadams';
import { cn } from '@/lib/utils';

type FrameworkUnsupportedLabelProps = {
  stepName: string;
  flowId: string;
  flowVersionId: string;
};

// ADR-0002 (#803): this release no longer runs the framework version the step's qadam was built
// for. The server decides (`GET /v1/framework-census/flow-version`); this only shows the answer.
// It marks the step and never blocks editing — updating the step is the remedy.
export function FrameworkUnsupportedLabel({
  stepName,
  flowId,
  flowVersionId,
}: FrameworkUnsupportedLabelProps) {
  const { t } = useTranslation();
  const { unsupportedStepNames } = qadamsHooks.useUnsupportedFrameworkSteps({
    flowId,
    flowVersionId,
  });
  if (!(unsupportedStepNames ?? []).includes(stepName)) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <p className="text-sm font-medium">
          {t('Framework version no longer supported')}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          'This step is pinned to a qadam version built for a framework version this release no longer runs. Update this step.',
        )}
      </p>
    </div>
  );
}
