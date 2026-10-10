import {
  flowQadamUtil,
  QadamAction,
  QadamTrigger,
  qadamVersionParser,
} from '@aiqadam/shared';
import { FlaskConical } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

type PreReleaseBuildLabelProps = {
  step: QadamAction | QadamTrigger;
};

// ADR-0004: a step whose pin is a snapshot (`x.y.z-main.<n>`) runs a build from `main`, not a
// release. It is informational — the version resolves and the step runs exactly that build — so
// nothing here is destructive and nothing blocks editing.
export function PreReleaseBuildLabel({ step }: PreReleaseBuildLabelProps) {
  const { t } = useTranslation();
  const isPreReleaseBuild = qadamVersionParser.isSnapshot({
    version: flowQadamUtil.getExactVersion(step.settings.qadamVersion),
  });
  if (!isPreReleaseBuild) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Pre-release build')}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          'This step is pinned to a build from main, not a released version. It runs that exact build until its version is updated.',
        )}
      </p>
    </div>
  );
}
