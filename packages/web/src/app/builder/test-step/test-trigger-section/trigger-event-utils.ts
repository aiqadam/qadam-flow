import { TriggerBase, TriggerStrategy } from '@aiqadam/qadams-framework';
import { TriggerTestStrategy } from '@aiqadam/shared';

import { qadamSelectorUtils } from '@/features/qadams';

export type TestType =
  | 'mcp-tool'
  | 'chat-trigger'
  | 'simulation'
  | 'webhook'
  | 'polling';

export const triggerEventUtils = {
  getTestType: ({
    triggerName,
    qadamName,
    trigger,
  }: {
    triggerName: string;
    qadamName: string;
    trigger: TriggerBase;
  }): TestType => {
    if (qadamSelectorUtils.isMcpToolTrigger(qadamName, triggerName)) {
      return 'mcp-tool';
    }
    if (qadamSelectorUtils.isChatTrigger(qadamName, triggerName)) {
      return 'chat-trigger';
    }
    if (
      qadamName === '@aiqadam/qadam-webhook' &&
      triggerName === 'catch_webhook'
    ) {
      return 'webhook';
    }

    if (
      trigger.type === TriggerStrategy.APP_WEBHOOK ||
      trigger.type === TriggerStrategy.WEBHOOK
    ) {
      switch (trigger.testStrategy) {
        case TriggerTestStrategy.TEST_FUNCTION:
          return 'polling';
        case TriggerTestStrategy.SIMULATION:
          return 'simulation';
      }
    }

    return 'polling';
  },
};
