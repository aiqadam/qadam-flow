import {
  FlowActionType,
  FlowOperationType,
  FlowTriggerType,
} from '@aiqadam/shared';
import React, { useState } from 'react';

import { CardListItemSkeleton } from '@/components/custom/card-list';
import { Separator } from '@/components/ui/separator';
import { VirtualizedScrollArea } from '@/components/ui/virtualized-scroll-area';
import {
  qadamsHooks,
  QadamSelectorTabType,
  useQadamSelectorTabs,
  QadamSelectorOperation,
  StepMetadataWithSuggestions,
  CategorizedStepMetadataWithSuggestions,
  PIECE_SELECTOR_ELEMENTS_HEIGHTS,
  qadamSelectorUtils,
} from '@/features/qadams';
import { useIsMobile } from '@/hooks/use-mobile';

import { cn } from '../../../lib/utils';
import { useBuilderStateContext } from '../builder-hooks';

import { NoResultsFound } from './no-results-found';
import { PieceActionsOrTriggersList } from './qadam-actions-or-triggers-list';
import { PieceCardListItem } from './qadam-card-item';

type PiecesCardListProps = {
  searchQuery: string;
  operation: QadamSelectorOperation;
  stepToReplaceQadamDisplayName?: string;
};

export const PiecesCardList: React.FC<PiecesCardListProps> = ({
  searchQuery,
  operation,
  stepToReplaceQadamDisplayName,
}) => {
  const isMobile = useIsMobile();
  const [selectedQadamMetadataInQadamSelector] = useBuilderStateContext(
    (state) => [state.selectedQadamMetadataInQadamSelector],
  );
  const { isLoading: isLoadingPieces, data: categories } =
    qadamsHooks.useQadamsSearch({
      shouldCaptureEvent: true,
      searchQuery,
      type:
        operation.type === FlowOperationType.UPDATE_TRIGGER
          ? 'trigger'
          : 'action',
    });

  const noResultsFound = !isLoadingPieces && categories.length === 0;
  const [mouseMoved, setMouseMoved] = useState(false);
  const showActionsOrTriggersInsideQadamsList =
    searchQuery.length > 0 || isMobile;
  const virtualizedItems = transformPiecesMetadataToVirtualizedItems(
    categories,
    showActionsOrTriggersInsideQadamsList,
  );

  const initialIndexToScrollToInQadamsList = virtualizedItems.findIndex(
    (item) => item.displayName === stepToReplaceQadamDisplayName,
  );
  const { selectedTab } = useQadamSelectorTabs();

  const isLoading = isLoadingPieces;
  const showActionsOrTriggersList =
    searchQuery.length === 0 && !isMobile && !noResultsFound && !isLoading;
  const showQadamsList = !noResultsFound && !isLoading;
  if (
    [
      QadamSelectorTabType.EXPLORE,
      QadamSelectorTabType.AI_AND_AGENTS,
      QadamSelectorTabType.APPROVALS,
    ].includes(selectedTab)
  ) {
    return null;
  }
  return (
    <>
      <div
        onMouseMove={() => {
          setMouseMoved(!isLoadingPieces);
        }}
        className={cn('w-full md:w-[250px] md:min-w-[250px] transition-all ', {
          'w-full md:w-full': searchQuery.length > 0 || noResultsFound,
        })}
      >
        {isLoading && (
          <div className="flex flex-col gap-2">
            <CardListItemSkeleton numberOfCards={2} withCircle={false} />
          </div>
        )}

        {showQadamsList && (
          <VirtualizedScrollArea
            key={`${selectedTab}-${searchQuery}`}
            initialScroll={{
              index: initialIndexToScrollToInQadamsList,
              clickAfterScroll: true,
            }}
            items={virtualizedItems}
            estimateSize={(index) => virtualizedItems[index].height}
            getItemKey={(index) => virtualizedItems[index].id}
            renderItem={(item) => {
              if (item.isCategory) {
                return (
                  <div
                    className={cn('p-2 pb-0 text-sm text-muted-foreground')}
                    id={item.displayName}
                  >
                    {item.displayName}
                  </div>
                );
              }
              return (
                <PieceCardListItem
                  qadamMetadata={item.qadamMetadata}
                  searchQuery={searchQuery}
                  operation={operation}
                  isTemporaryDisabledUntilNextCursorMove={!mouseMoved}
                />
              );
            }}
          />
        )}

        {noResultsFound && <NoResultsFound />}
      </div>

      {showActionsOrTriggersList && (
        <>
          <Separator orientation="vertical" className="h-full" />
          <PieceActionsOrTriggersList
            stepMetadataWithSuggestions={selectedQadamMetadataInQadamSelector}
            hideQadamIconAndDescription={false}
            operation={operation}
          />
        </>
      )}
    </>
  );
};

type VirtualizedItem = {
  id: string;
  displayName: string;
  height: number;
} & (
  | {
      isCategory: true;
    }
  | {
      isCategory: false;
      qadamMetadata: StepMetadataWithSuggestions;
    }
);
const transformPiecesMetadataToVirtualizedItems = (
  searchResult: CategorizedStepMetadataWithSuggestions[],
  showActionsOrTriggersInsideQadamsList: boolean,
) => {
  return searchResult.reduce<VirtualizedItem[]>((result, category) => {
    if (!showActionsOrTriggersInsideQadamsList) {
      result.push({
        id: category.title,
        displayName: category.title,
        height: PIECE_SELECTOR_ELEMENTS_HEIGHTS.CATEGORY_ITEM_HEIGHT,
        isCategory: true,
      });
    }
    category.metadata.forEach((qadamMetadata, index) => {
      result.push({
        id: `${qadamMetadata.displayName}-${index}`,
        height: getItemHeight(
          qadamMetadata,
          showActionsOrTriggersInsideQadamsList,
        ),
        isCategory: false,
        qadamMetadata,
        displayName: qadamMetadata.displayName,
      });
    });
    return result;
  }, []);
};

const getItemHeight = (
  qadamMetadata: StepMetadataWithSuggestions,
  showActionsOrTriggersInsideQadamsList: boolean,
) => {
  const { ACTION_OR_TRIGGER_ITEM_HEIGHT, PIECE_ITEM_HEIGHT } =
    PIECE_SELECTOR_ELEMENTS_HEIGHTS;
  if (
    qadamMetadata.type === FlowActionType.PIECE &&
    showActionsOrTriggersInsideQadamsList
  ) {
    const actionsListWithoutHiddenActions =
      qadamSelectorUtils.removeHiddenActions(qadamMetadata);
    return (
      ACTION_OR_TRIGGER_ITEM_HEIGHT *
        Object.values(actionsListWithoutHiddenActions).length +
      PIECE_ITEM_HEIGHT
    );
  }
  if (
    qadamMetadata.type === FlowTriggerType.PIECE &&
    showActionsOrTriggersInsideQadamsList
  ) {
    return (
      ACTION_OR_TRIGGER_ITEM_HEIGHT *
        Object.values(qadamMetadata.suggestedTriggers ?? {}).length +
      PIECE_ITEM_HEIGHT
    );
  }
  const isCoreAction =
    qadamMetadata.type === FlowActionType.CODE ||
    qadamMetadata.type === FlowActionType.LOOP_ON_ITEMS ||
    qadamMetadata.type === FlowActionType.ROUTER;
  if (isCoreAction && showActionsOrTriggersInsideQadamsList) {
    return ACTION_OR_TRIGGER_ITEM_HEIGHT + PIECE_ITEM_HEIGHT;
  }
  return PIECE_ITEM_HEIGHT;
};
