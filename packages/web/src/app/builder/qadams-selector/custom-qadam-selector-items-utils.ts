import { FlowOperationType } from '@aiqadam/shared';

import {
  QadamSelectorOperation,
  QadamSelectorQadamItem,
  qadamSelectorUtils,
} from '@/features/qadams';

import { BuilderState } from '../builder-hooks';

export const handleAddingOrUpdatingCustomAgentQadamSelectorItem = (
  agentQadamSelectorItem: QadamSelectorQadamItem,
  operation: QadamSelectorOperation,
  handleAddingOrUpdatingStep: BuilderState['handleAddingOrUpdatingStep'],
) => {
  const stepName = handleAddingOrUpdatingStep({
    qadamSelectorItem: agentQadamSelectorItem,
    operation,
    selectStepAfter: true,
  });
  const defaultValues = qadamSelectorUtils.getDefaultStepValues({
    stepName,
    qadamSelectorItem: agentQadamSelectorItem,
  });
  return handleAddingOrUpdatingStep({
    qadamSelectorItem: agentQadamSelectorItem,
    operation: {
      type: FlowOperationType.UPDATE_ACTION,
      stepName,
    },
    selectStepAfter: false,
    overrideSettings: defaultValues.settings,
  });
};
