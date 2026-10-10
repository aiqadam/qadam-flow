import { OAuth2Props, QadamPropertyMap } from '@aiqadam/qadams-framework';
import {
  FlowActionType,
  FlowOperationRequest,
  FlowOperationType,
  FlowTriggerType,
  isNil,
  QadamAction,
  QadamTrigger,
  qadamVersionParser,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { AlertTriangle, ArrowUp, Info } from 'lucide-react';
import semver from 'semver';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { formUtils, qadamSelectorUtils, qadamsApi } from '@/features/qadams';

function getVersionChangeType({
  currentVersion,
  selectedVersion,
}: {
  currentVersion: string;
  selectedVersion: string;
}): VersionChangeType {
  if (currentVersion === selectedVersion)
    return VersionChangeType.PATCH_UPGRADE;

  const current = semver.parse(currentVersion);
  const selected = semver.parse(selectedVersion);
  if (!current || !selected) return VersionChangeType.MINOR_OR_MAJOR;

  if (current.major !== selected.major || current.minor !== selected.minor) {
    return VersionChangeType.MINOR_OR_MAJOR;
  }
  if (semver.lt(selectedVersion, currentVersion)) {
    return VersionChangeType.PATCH_DOWNGRADE;
  }
  return VersionChangeType.PATCH_UPGRADE;
}

function getLatestMinorOrMajorUpgrade({
  currentVersion,
  versions,
}: {
  currentVersion: string;
  versions: { version: string }[];
}): string | undefined {
  const latest = versions[0]?.version;
  if (!latest) return undefined;
  const changeType = getVersionChangeType({
    currentVersion,
    selectedVersion: latest,
  });
  if (
    changeType === VersionChangeType.MINOR_OR_MAJOR &&
    semver.gt(latest, currentVersion)
  ) {
    return latest;
  }
  return undefined;
}

function getInputAfterVersionChange({
  versionChangeType,
  props,
  currentInput,
}: {
  versionChangeType: VersionChangeType;
  props: QadamPropertyMap | OAuth2Props;
  currentInput: Record<string, unknown>;
}): Record<string, unknown> {
  if (versionChangeType === VersionChangeType.MINOR_OR_MAJOR) {
    return formUtils.getDefaultValueForProperties({
      props: { ...props },
      existingInput: {},
    });
  }
  if (versionChangeType === VersionChangeType.PATCH_DOWNGRADE) {
    return formUtils.getDefaultValueForProperties({
      props: { ...props },
      existingInput: currentInput,
    });
  }
  return currentInput;
}

function getLatestVersion({
  currentVersion,
  versions,
}: {
  currentVersion: string;
  versions: { version: string }[];
}): string | undefined {
  const latest = versions[0]?.version;
  if (!latest || !semver.gt(latest, currentVersion)) return undefined;
  return latest;
}

// ADR-0004: the release a snapshot pin (`x.y.z-main.<n>`) graduates to. The candidates are the
// releases inside the pin's own range — `^` when it carries one or none, a `~` pin staying on its
// minor — the same expression the export rewrite uses (`snapshot-pin-export.ts`:
// `${pin.range ?? '^'}${base}`). For `^` that range is the caret: the same major, or on `0.x` the
// same minor, and it contains the base release (`^1.3.0-main.412` contains `1.3.0`) as well as later
// patches (`1.3.2`). `getLatestVersion` above compares with plain `semver.gt` and does not apply the
// range, so it must not be reused here: it would offer a release outside the pin. Prereleases are
// never candidates — only releases graduate a snapshot.
function getLatestReleaseInsideCaret({
  pin,
  versions,
}: {
  pin: string;
  versions: { version: string }[];
}): string | undefined {
  const parsed = qadamVersionParser.parsePin({ pin });
  if (isNil(parsed)) return undefined;
  const { major, minor, patch } = parsed.version;
  const range = `${parsed.range ?? '^'}${major}.${minor}.${patch}`;
  return versions
    .map((entry) => entry.version)
    .filter(
      (version) =>
        qadamVersionParser.isRelease({ version }) &&
        semver.satisfies(version, range),
    )
    .sort(semver.rcompare)[0];
}

export function LatestVersionAvailableAlert({
  isLatestMinorOrMajor,
}: LatestVersionAvailableAlertProps) {
  return (
    <Alert variant={isLatestMinorOrMajor ? 'warning' : 'default'}>
      {isLatestMinorOrMajor ? (
        <AlertTriangle className="size-4" />
      ) : (
        <ArrowUp className="size-4" />
      )}
      <AlertTitle>
        {isLatestMinorOrMajor
          ? t('Significant update available')
          : t('Newer version available')}
      </AlertTitle>
      <AlertDescription>
        {isLatestMinorOrMajor
          ? t('MajorUpgradeNote')
          : t(
              'Settings will carry over. Retest the step as the output may have changed.',
            )}
      </AlertDescription>
    </Alert>
  );
}

export function MinorOrMajorSelectionAlert() {
  return (
    <Alert variant="warning">
      <AlertTriangle className="size-4" />
      <AlertDescription>{t('MajorUpgradeNote')}</AlertDescription>
    </Alert>
  );
}

export function PatchUpgradeInfoAlert() {
  return (
    <Alert>
      <Info className="size-4" />
      <AlertDescription>
        {t('Settings will carry over. Retest as the output may have changed.')}
      </AlertDescription>
    </Alert>
  );
}

export function PatchDowngradeInfoAlert() {
  return (
    <Alert>
      <Info className="size-4" />
      <AlertDescription>
        {t(
          "You're switching to an older patch. Your settings will be kept where possible.",
        )}
      </AlertDescription>
    </Alert>
  );
}

async function applyPieceVersionChange({
  step,
  targetVersion,
  currentVersion,
  applyOperation,
}: {
  step: QadamAction | QadamTrigger;
  targetVersion: string;
  currentVersion: string;
  applyOperation: (operation: FlowOperationRequest) => void;
}) {
  const qadamName = step.settings.qadamName;
  const actionOrTriggerName =
    step.type === FlowTriggerType.PIECE
      ? (step.settings.triggerName ?? '')
      : (step.settings.actionName ?? '');

  const piece = await qadamsApi.get({
    name: qadamName,
    version: targetVersion,
  });
  const changeType = getVersionChangeType({
    currentVersion,
    selectedVersion: targetVersion,
  });

  const actionOrTriggerDef =
    step.type === FlowTriggerType.PIECE
      ? piece.triggers[actionOrTriggerName]
      : piece.actions[actionOrTriggerName];

  if (isNil(actionOrTriggerDef)) {
    throw new Error(
      t(
        'The selected version does not include the current action or trigger. Please choose a different version.',
      ),
    );
  }

  const input = getInputAfterVersionChange({
    versionChangeType: changeType,
    props: actionOrTriggerDef.props,
    currentInput: step.settings.input,
  });

  const valid = qadamSelectorUtils.isPieceStepInputValid({
    props: actionOrTriggerDef.props,
    auth: piece.auth,
    input,
    requireAuth: actionOrTriggerDef.requireAuth,
  });

  if (step.type === FlowTriggerType.PIECE) {
    applyOperation({
      type: FlowOperationType.UPDATE_TRIGGER,
      request: {
        ...step,
        type: FlowTriggerType.PIECE,
        valid,
        settings: {
          ...step.settings,
          qadamVersion: targetVersion,
          input,
        },
      },
    });
  } else {
    applyOperation({
      type: FlowOperationType.UPDATE_ACTION,
      request: {
        ...step,
        type: FlowActionType.PIECE,
        valid,
        settings: {
          ...step.settings,
          qadamVersion: targetVersion,
          input,
        },
      },
    });
  }

  if (changeType === VersionChangeType.MINOR_OR_MAJOR) {
    applyOperation({
      type: FlowOperationType.UPDATE_SAMPLE_DATA_INFO,
      request: {
        stepName: step.name,
        sampleDataSettings: undefined,
      },
    });
  }
}

export const changeVersionUtils = {
  getVersionChangeType,
  getInputAfterVersionChange,
  getLatestMinorOrMajorUpgrade,
  getLatestVersion,
  getLatestReleaseInsideCaret,
  applyPieceVersionChange,
};

export enum VersionChangeType {
  MINOR_OR_MAJOR = 'MINOR_OR_MAJOR',
  PATCH_DOWNGRADE = 'PATCH_DOWNGRADE',
  PATCH_UPGRADE = 'PATCH_UPGRADE',
}

type LatestVersionAvailableAlertProps = {
  isLatestMinorOrMajor: boolean;
};
