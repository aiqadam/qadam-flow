import { isNil } from '@aiqadam/shared';

import { ResourceLockWidget } from '@/components/custom/resource-lock-widget';

import { useBuilderStateContext } from '../../builder-hooks';

import { FlowUpdatesHaltedWidget } from './flow-updates-halted-widget';
import { PublishFlowReminderWidget } from './publish-flow-reminder-widget';
import { RunInfoWidget } from './run-info-widget';
import { useFlowLock } from './use-flow-lock';
import { ViewingOldVersionWidget } from './viewing-old-version-widget';

const BuilderBanner = () => {
  const { lockedBy, takeOver } = useFlowLock();
  const [run, queueHalted] = useBuilderStateContext((state) => [
    state.run,
    state.queueHalted,
  ]);

  // Shown instead of the publish reminder: publishing now would publish the server's draft,
  // which is missing the edit that failed to save and everything after it.
  if (queueHalted) {
    return <FlowUpdatesHaltedWidget />;
  }
  if (lockedBy) {
    return (
      <ResourceLockWidget
        lockedBy={lockedBy}
        takeOver={takeOver}
        resourceLabel="flow"
      />
    );
  }
  if (!isNil(run)) {
    return <RunInfoWidget />;
  }
  return (
    <>
      <ViewingOldVersionWidget />
      <PublishFlowReminderWidget />
    </>
  );
};

BuilderBanner.displayName = 'BuilderBanner';
export { BuilderBanner };
