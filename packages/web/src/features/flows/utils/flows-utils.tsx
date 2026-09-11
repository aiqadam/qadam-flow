import {
  PopulatedFlow,
  FlowTriggerType,
  LongPollingStatus,
  isNil,
} from '@aiqadam/shared';
import cronstrue from 'cronstrue/i18n';
import { t } from 'i18next';
import JSZip from 'jszip';
import {
  AlertCircle,
  RefreshCw,
  TimerReset,
  TriangleAlert,
  Zap,
} from 'lucide-react';

import { downloadFile } from '@/lib/dom-utils';
import { formatUtils } from '@/lib/format-utils';

import { flowsApi } from '../api/flows-api';

const downloadFlow = async (flowId: string) => {
  const template = await flowsApi.getTemplate(flowId, {});
  downloadFile({
    obj: JSON.stringify(template, null, 2),
    fileName: template.name,
    extension: 'json',
  });
};

const zipFlows = async (flows: PopulatedFlow[]) => {
  const zip = new JSZip();
  for (const flow of flows) {
    const template = await flowsApi.getTemplate(flow.id, {});
    zip.file(
      `${flow.version.displayName}_${flow.id}.json`,
      JSON.stringify(template, null, 2),
    );
  }
  return zip;
};

/**
 * A flow served by the long-polling host can be on, published and still receiving nothing — a
 * revoked bot token, or a webhook the third party has not let go of. The enable switch says "on"
 * in every one of those cases, so this is the only place the user is told otherwise.
 */
const longPollingIssue = (flow: PopulatedFlow) => {
  const longPolling = flow.triggerSource?.longPolling;
  if (isNil(longPolling) || longPolling.status === LongPollingStatus.POLLING) {
    return null;
  }
  return longPolling;
};

/**
 * A healthy pulling flow, which looked exactly like every other real-time flow before this: no
 * badge at all. That made the absence of one ambiguous — polled and fine, not polled, or polling
 * switched off instance-wide all rendered identically, and the tooltip said "Real time flow" for
 * each. It replaces the generic icon rather than sitting next to it, so the row gains no clutter.
 */
const longPollingHealthy = (flow: PopulatedFlow) => {
  const longPolling = flow.triggerSource?.longPolling;
  return longPolling?.status === LongPollingStatus.POLLING ? longPolling : null;
};

export const flowsUtils = {
  downloadFlow,
  zipFlows,
  flowStatusToolTipRenderer: (flow: PopulatedFlow) => {
    const trigger = flow.version.trigger;
    const issue = longPollingIssue(flow);
    if (issue) {
      const headline =
        issue.status === LongPollingStatus.STOPPED
          ? t('Not receiving updates. Turn the flow off and on again to retry.')
          : t('Retrying — updates may be delayed.');
      return issue.reason ? `${headline} ${issue.reason}` : headline;
    }
    const polling = longPollingHealthy(flow);
    if (polling) {
      return t('Receiving updates by polling since {since}', {
        since: formatUtils.formatDate(new Date(polling.since)),
      });
    }
    switch (trigger?.type) {
      case FlowTriggerType.PIECE: {
        const cronExpression = flow.triggerSource?.schedule?.cronExpression;
        return cronExpression
          ? `${t('Run')} ${cronstrue
              .toString(cronExpression, { locale: 'en' })
              .toLocaleLowerCase()}`
          : t('Real time flow');
      }
      case FlowTriggerType.EMPTY:
        console.error(
          t("Flow can't be published with empty trigger {name}", {
            name: flow.version.displayName,
          }),
        );
        return t('Please contact support as your published flow has a problem');
    }
  },
  flowStatusIconRenderer: (flow: PopulatedFlow) => {
    const trigger = flow.version.trigger;
    const issue = longPollingIssue(flow);
    if (issue) {
      return issue.status === LongPollingStatus.STOPPED ? (
        <TriangleAlert className="h-4 w-4 text-destructive" />
      ) : (
        <AlertCircle className="h-4 w-4 text-warning" />
      );
    }
    if (longPollingHealthy(flow)) {
      return <RefreshCw className="h-4 w-4 text-foreground" />;
    }
    switch (trigger?.type) {
      case FlowTriggerType.PIECE: {
        const cronExpression = flow.triggerSource?.schedule?.cronExpression;
        if (cronExpression) {
          return <TimerReset className="h-4 w-4 text-foreground" />;
        } else {
          return <Zap className="h-4 w-4 text-foreground fill-foreground" />;
        }
      }
      case FlowTriggerType.EMPTY: {
        console.error(
          t("Flow can't be published with empty trigger {name}", {
            name: flow.version.displayName,
          }),
        );
        return <TriangleAlert className="h-4 w-4 text-destructive" />;
      }
    }
  },
};
