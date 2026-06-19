import { FlowActionType, FlowTriggerType } from '@aiqadam/shared';

import { CardListItem } from '@/components/custom/card-list';
import {
  QadamIcon,
  QadamSelectorItem,
  StepMetadataWithSuggestions,
  PIECE_SELECTOR_ELEMENTS_HEIGHTS,
} from '@/features/qadams';
import { cn } from '@/lib/utils';
type GenericActionOrTriggerItemProps = {
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

const GenericActionOrTriggerItem = ({
  item,
  hideQadamIconAndDescription,
  stepMetadataWithSuggestions,
  onClick,
}: GenericActionOrTriggerItemProps) => {
  // we add this style because we hide the piece icon and description when they are in a virtualized list
  const style = hideQadamIconAndDescription
    ? {
        height: `${PIECE_SELECTOR_ELEMENTS_HEIGHTS.ACTION_OR_TRIGGER_ITEM_HEIGHT}px`,
        maxHeight: `${PIECE_SELECTOR_ELEMENTS_HEIGHTS.ACTION_OR_TRIGGER_ITEM_HEIGHT}px`,
      }
    : {
        minHeight: '54px',
      };
  const qadamSelectorItemInfo = getPieceSelectorItemInfo(item);
  return (
    <CardListItem
      className={cn('p-2 w-full ', {
        truncate: hideQadamIconAndDescription,
      })}
      onClick={onClick}
      style={style}
    >
      <div className="flex gap-3 items-center">
        <div
          className={cn({
            'opacity-0': hideQadamIconAndDescription,
          })}
        >
          <QadamIcon
            logoUrl={stepMetadataWithSuggestions.logoUrl}
            displayName={stepMetadataWithSuggestions.displayName}
            showTooltip={false}
            size={'sm'}
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <div className="text-sm">{qadamSelectorItemInfo.displayName}</div>
          {!hideQadamIconAndDescription && (
            <div className="text-xs text-muted-foreground">
              {qadamSelectorItemInfo.description.endsWith('.')
                ? qadamSelectorItemInfo.description.slice(0, -1)
                : qadamSelectorItemInfo.description}
            </div>
          )}
        </div>
      </div>
    </CardListItem>
  );
};

GenericActionOrTriggerItem.displayName = 'GenericActionOrTriggerItem';
export default GenericActionOrTriggerItem;
