import { FlowActionType, FlowTriggerType } from '@aiqadam/shared';

import { CardListItem } from '@/components/custom/card-list';
import {
  QadamIcon,
  QadamSelectorItem,
  StepMetadataWithSuggestions,
} from '@/features/qadams';

type AIActionItemProps = {
  item: QadamSelectorItem;
  hideQadamIconAndDescription: boolean;
  stepMetadataWithSuggestions: StepMetadataWithSuggestions;
  onClick: () => void;
};

const getPieceSelectorItemInfo = (item: QadamSelectorItem) => {
  if (
    item.type === FlowActionType.PIECE ||
    item.type === FlowTriggerType.PIECE
  ) {
    return {
      displayName: item.actionOrTrigger.displayName,
      description: item.actionOrTrigger.description,
    };
  }
  return {
    displayName: item.displayName,
    description: item.description,
  };
};

const AIActionItem = ({
  item,
  stepMetadataWithSuggestions,
  onClick,
}: AIActionItemProps) => {
  const qadamSelectorItemInfo = getPieceSelectorItemInfo(item);

  return (
    <CardListItem
      className="p-4 w-full h-full rounded-md flex flex-col justify-between h-[125px]"
      onClick={onClick}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-center">
          <QadamIcon
            logoUrl={stepMetadataWithSuggestions.logoUrl}
            displayName={stepMetadataWithSuggestions.displayName}
            showTooltip={false}
            size={'lg'}
          />
        </div>
        <div className="flex flex-col gap-1 text-center">
          <div className="text-sm font-medium leading-tight">
            {qadamSelectorItemInfo.displayName}
          </div>
        </div>
      </div>
    </CardListItem>
  );
};

AIActionItem.displayName = 'AIActionItem';
export default AIActionItem;
