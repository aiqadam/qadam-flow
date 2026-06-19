import { useRef } from 'react';

import { CardListItem } from '@/components/custom/card-list';
import {
  QadamIcon,
  QadamSelectorOperation,
  StepMetadataWithSuggestions,
  PIECE_SELECTOR_ELEMENTS_HEIGHTS,
} from '@/features/qadams';
import { useIsMobile } from '@/hooks/use-mobile';
import { wait } from '@/lib/dom-utils';
import { cn } from '@/lib/utils';

import { useBuilderStateContext } from '../builder-hooks';

import { PieceActionsOrTriggersList } from './qadam-actions-or-triggers-list';

type PieceCardListItemProps = {
  qadamMetadata: StepMetadataWithSuggestions;
  searchQuery: string;
  operation: QadamSelectorOperation;
  isTemporaryDisabledUntilNextCursorMove: boolean;
};

const PieceCardListItem = ({
  qadamMetadata,
  searchQuery,
  operation,
  isTemporaryDisabledUntilNextCursorMove,
}: PieceCardListItemProps) => {
  const isMobile = useIsMobile();
  const showSuggestions = searchQuery.length > 0 || isMobile;
  const isMouseOver = useRef(false);
  const selectPieceMetatdata = async () => {
    if (isTemporaryDisabledUntilNextCursorMove || showSuggestions) {
      return;
    }
    isMouseOver.current = true;
    await wait(250);
    if (isMouseOver.current) {
      setSelectedQadamMetadataInQadamSelector(qadamMetadata);
    }
  };
  const [
    selectedQadamMetadataInQadamSelector,
    setSelectedQadamMetadataInQadamSelector,
  ] = useBuilderStateContext((state) => [
    state.selectedQadamMetadataInQadamSelector,
    state.setSelectedQadamMetadataInQadamSelector,
  ]);
  const itemHeight = PIECE_SELECTOR_ELEMENTS_HEIGHTS.PIECE_ITEM_HEIGHT;
  return (
    <>
      <CardListItem
        className={cn('flex-col p-3 gap-1 items-start truncate', {
          'hover:bg-transparent!': isTemporaryDisabledUntilNextCursorMove,
        })}
        style={{ height: `${itemHeight}px`, maxHeight: `${itemHeight}px` }}
        selected={
          selectedQadamMetadataInQadamSelector?.displayName ===
            qadamMetadata.displayName && searchQuery.length === 0
        }
        interactive={!showSuggestions}
        onMouseEnter={selectPieceMetatdata}
        onMouseMove={selectPieceMetatdata}
        onClick={() => {
          if (!showSuggestions) {
            setSelectedQadamMetadataInQadamSelector(qadamMetadata);
          }
        }}
        onMouseLeave={() => {
          isMouseOver.current = false;
        }}
        id={qadamMetadata.displayName}
        data-testid={qadamMetadata.displayName}
      >
        <div className="flex gap-2 items-center h-full">
          <QadamIcon
            logoUrl={qadamMetadata.logoUrl}
            displayName={qadamMetadata.displayName}
            showTooltip={false}
            size={'sm'}
          />
          <div className="grow h-full flex items-center justify-left text-sm">
            {qadamMetadata.displayName}
          </div>
        </div>
      </CardListItem>

      {showSuggestions && (
        <div>
          <PieceActionsOrTriggersList
            stepMetadataWithSuggestions={qadamMetadata}
            hideQadamIconAndDescription={true}
            operation={operation}
          />
        </div>
      )}
    </>
  );
};

PieceCardListItem.displayName = 'PieceCardListItem';
export { PieceCardListItem };
