import { t } from 'i18next';
import { TriangleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

import { frameworkCensusQueries } from '../lib/framework-census-hooks';

// How many affected flows the banner names before collapsing the rest into a count.
const MAX_LISTED_FLOWS = 5;

// The census's name for a qadam built before `getContextInfo` existed (`PREDATES_CONTEXT_INFO` in
// the framework, which the web bundle does not import).
const PREDATES_CONTEXT_INFO = 'none';

// ADR-0002 (#803): after a release retires a framework context version, the steps pinned to
// qadams built against it stop running. The release does not block and no flow is disabled (#435),
// so this banner is where the operator sees the consequence and the repair path.
export function FrameworkCensusBanner() {
  const { data } = frameworkCensusQueries.useCensus();

  if (!data || !data.ran || data.summary.unsupported === 0) {
    return null;
  }

  const affectedFlows = [
    ...new Map(
      data.steps
        .filter((step) => step.status === 'unsupported')
        .map((step) => [step.flowId, step]),
    ).values(),
  ];
  const listed = affectedFlows.slice(0, MAX_LISTED_FLOWS);
  // The response caps its step list, so the count of the rest comes from the summary.
  const remaining = data.summary.flowsWithUnsupportedSteps - listed.length;

  return (
    <Alert variant="warning">
      <TriangleAlert />
      <AlertTitle>{t('Framework version retirement')}</AlertTitle>
      <AlertDescription>
        {t(
          'This release no longer runs: {versions}. Affected steps: {unsupported}. Affected flows: {flows}. Update each step to a qadam version built against a supported framework version.',
          {
            versions: data.retiredContextVersions
              .map(contextVersionLabel)
              .join(', '),
            unsupported: data.summary.unsupported,
            flows: data.summary.flowsWithUnsupportedSteps,
          },
        )}
        <ul className="mt-2 list-disc pl-4">
          {listed.map((step) => (
            <li key={step.flowId}>
              {step.projectDisplayName} — {step.flowDisplayName}
            </li>
          ))}
          {remaining > 0 && <li>{t('and {remaining} more', { remaining })}</li>}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

// The census reports context versions as the engine names them ('1', 'none'); the banner names
// them in words.
function contextVersionLabel(version: string): string {
  return version === PREDATES_CONTEXT_INFO
    ? t('qadams that predate context versions')
    : t('context version {version}', { version });
}
