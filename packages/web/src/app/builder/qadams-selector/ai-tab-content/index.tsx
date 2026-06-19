import { FlowOperationType, isNil } from '@aiqadam/shared';

import { CardListItemSkeleton } from '@/components/custom/card-list';
import {
  qadamsHooks,
  QadamSelectorTabType,
  useQadamSelectorTabs,
  QadamSelectorOperation,
  stepUtils,
} from '@/features/qadams';

import { AIPieceActionsList } from './ai-actions-list';

const AITabContent = ({ operation }: { operation: QadamSelectorOperation }) => {
  const { selectedTab } = useQadamSelectorTabs();
  const { qadamModel, isLoading } = qadamsHooks.useQadam({
    name: '@aiqadam/qadam-ai',
  });

  if (
    selectedTab !== QadamSelectorTabType.AI_AND_AGENTS ||
    ![FlowOperationType.ADD_ACTION, FlowOperationType.UPDATE_ACTION].includes(
      operation.type,
    )
  ) {
    return null;
  }

  if (isLoading || isNil(qadamModel)) {
    return (
      <div className="flex flex-col gap-2 w-full">
        <CardListItemSkeleton numberOfCards={2} withCircle={false} />
      </div>
    );
  }

  const metadata = stepUtils.mapPieceToMetadata({
    piece: qadamModel,
    type: 'action',
  });

  const qadamMetadataWithSuggestion = {
    ...metadata,
    suggestedActions: Object.values(qadamModel?.actions),
    suggestedTriggers: Object.values(qadamModel.triggers),
  };

  return (
    <div className="w-full">
      <AIPieceActionsList
        stepMetadataWithSuggestions={qadamMetadataWithSuggestion}
        hideQadamIconAndDescription={false}
        operation={operation}
      />
    </div>
  );
};

export { AITabContent };
