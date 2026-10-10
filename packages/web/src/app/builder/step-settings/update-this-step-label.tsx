import {
  AgentQadamProps,
  AgentQadamTool,
  flowQadamUtil,
  isNil,
  QadamAction,
  QadamTrigger,
  qadamVersionParser,
} from '@aiqadam/shared';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

import { UpdatePieceVersionDialog } from './update-qadam-version-dialog/update-qadam-version-dialog';

type UpdateThisStepLabelProps = {
  step: QadamAction | QadamTrigger;
  readonly: boolean;
};

// ADR-0004: an import sets `exportedUnresolvedPin` on a step whose exporter could not move a
// snapshot pin to a release. The mark is advisory builder state — a file or an editor can set it —
// so it only points the person at the existing version update; it never moves or blocks anything.
// A step's own mark holds while its version is still the recorded, snapshot one. A mark that came
// from an agent tool records the agent step's own version (a release), so the importer cannot tell
// the origins apart here and the tools' pins are what counts.
export function UpdateThisStepLabel({
  step,
  readonly,
}: UpdateThisStepLabelProps) {
  const { t } = useTranslation();
  const mark = step.settings.exportedUnresolvedPin;
  if (isNil(mark)) {
    return null;
  }
  const exactVersion = flowQadamUtil.getExactVersion(
    step.settings.qadamVersion
  );
  const isOwnPinMarked =
    mark === exactVersion &&
    qadamVersionParser.isSnapshot({ version: exactVersion });
  const hasSnapshotTool = hasSnapshotToolPin({ input: step.settings.input });
  if (!isOwnPinMarked && !hasSnapshotTool) {
    return null;
  }
  return (
    <div
      className={cn('flex flex-col gap-3 rounded-md border border-dashed p-4')}
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm font-medium">{t('Update this step')}</p>
      </div>
      <p className="text-sm text-muted-foreground">
        {isOwnPinMarked
          ? t(
              'This step was imported with a pre-release build that could not be moved to a released version. Update its version.'
            )
          : t(
              'This step was imported with an agent tool pinned to a pre-release build that could not be moved to a released version. Update that tool.'
            )}
      </p>
      {isOwnPinMarked && !readonly && (
        <UpdatePieceVersionDialog
          step={step}
          currentVersion={exactVersion}
          variant="labelled"
        />
      )}
    </div>
  );
}

function hasSnapshotToolPin({
  input,
}: {
  input: Record<string, unknown>;
}): boolean {
  const tools = input[AgentQadamProps.AGENT_TOOLS];
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some((tool) => {
    const parsed = AgentQadamTool.safeParse(tool);
    return (
      parsed.success &&
      qadamVersionParser.isSnapshot({
        version: flowQadamUtil.getExactVersion(
          parsed.data.qadamMetadata.qadamVersion
        ),
      })
    );
  });
}
