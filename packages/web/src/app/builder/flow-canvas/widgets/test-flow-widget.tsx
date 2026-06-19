import {
  isNil,
  FlowTriggerType,
  UpdateRunProgressRequest,
  assertNotNullOrUndefined,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { useRef } from 'react';

import { EditFlowOrViewDraftButton } from '@/app/builder/builder-header/flow-status/view-draft-or-edit-flow-button';
import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import { ChatDrawerSource } from '@/app/builder/types';
import { flowRunUtils } from '@/features/flow-runs';
import { flowHooks } from '@/features/flows';
import { qadamSelectorUtils } from '@/features/qadams';

import { AboveTriggerButton } from './above-trigger-button';

const TestFlowWidget = () => {
  const [
    setChatDrawerOpenSource,
    flowVersion,
    readonly,
    hideTestWidget,
    run,
    setRun,
    publishedVersionId,
  ] = useBuilderStateContext((state) => [
    state.setChatDrawerOpenSource,
    state.flowVersion,
    state.readonly,
    state.hideTestWidget,
    state.run,
    state.setRun,
    state.flow.publishedVersionId,
  ]);
  const runRef = useRef(run);
  runRef.current = run;

  const triggerHasSampleData =
    flowVersion.trigger.type === FlowTriggerType.PIECE &&
    !isNil(flowVersion.trigger.settings.sampleData?.lastTestDate);

  const isChatTrigger = qadamSelectorUtils.isChatTrigger(
    flowVersion.trigger.settings.qadamName,
    flowVersion.trigger.settings.triggerName,
  );
  const isManualTrigger = qadamSelectorUtils.isManualTrigger({
    qadamName: flowVersion.trigger.settings.qadamName,
    triggerName: flowVersion.trigger.settings.triggerName,
  });

  const { mutate: runFlow, isPending: isTestingFlow } =
    flowHooks.useTestFlowOrStartManualTrigger({
      flowVersionId: flowVersion.id,
      isForManualTrigger: isManualTrigger,
      onUpdateRun: (response: UpdateRunProgressRequest) => {
        assertNotNullOrUndefined(response.flowRun, 'flowRun');
        const steps = runRef.current?.steps ?? {};
        const startTime =
          response.flowRun.startTime ?? runRef.current?.startTime;
        if (!isNil(response.step)) {
          const updatedSteps = flowRunUtils.updateRunSteps(
            steps,
            response.step?.name,
            response.step?.path,
            response.step?.output,
          );
          setRun(
            { ...response.flowRun, startTime, steps: updatedSteps },
            flowVersion,
          );
        }
        setRun({ ...response.flowRun, startTime, steps }, flowVersion);
      },
    });

  if (!flowVersion.valid) {
    return null;
  }

  if (hideTestWidget) {
    return null;
  }
  if (
    isManualTrigger &&
    (publishedVersionId !== flowVersion.id || isNil(publishedVersionId))
  ) {
    return null;
  }

  if (readonly) {
    return (
      <EditFlowOrViewDraftButton onCanvas={true}></EditFlowOrViewDraftButton>
    );
  }

  if (isChatTrigger) {
    return (
      <AboveTriggerButton
        onClick={() => {
          setChatDrawerOpenSource(ChatDrawerSource.TEST_FLOW);
        }}
        text={t('Open Chat')}
        loading={isTestingFlow}
      />
    );
  }

  return (
    <AboveTriggerButton
      onClick={() => {
        runFlow();
      }}
      text={isManualTrigger ? t('Run Flow') : t('Test Flow')}
      disable={!triggerHasSampleData && !isManualTrigger}
      loading={isTestingFlow}
    />
  );
};

TestFlowWidget.displayName = 'TestFlowWidget';

export { TestFlowWidget };
