import { FlowOperationType } from '@aiqadam/shared';

import {
  CardListItem,
  CardListItemSkeleton,
} from '@/components/custom/card-list';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  QadamIcon,
  qadamsHooks,
  QadamSelectorTabType,
  useQadamSelectorTabs,
  QadamSelectorOperation,
} from '@/features/qadams';

import { PieceActionsOrTriggersList } from './qadam-actions-or-triggers-list';

const ExploreTabContent = ({
  operation,
}: {
  operation: QadamSelectorOperation;
}) => {
  const { selectedTab, selectedQadamInExplore, setSelectedQadamInExplore } =
    useQadamSelectorTabs();
  const { data: categories, isLoading: isLoadingPieces } =
    qadamsHooks.useQadamsSearch({
      shouldCaptureEvent: false,
      searchQuery: '',
      type:
        operation.type === FlowOperationType.UPDATE_TRIGGER
          ? 'trigger'
          : 'action',
    });
  if (selectedTab !== QadamSelectorTabType.EXPLORE) {
    return null;
  }
  if (isLoadingPieces) {
    return (
      <div className="flex flex-col gap-2 w-full">
        <CardListItemSkeleton numberOfCards={2} withCircle={false} />
      </div>
    );
  }

  if (selectedQadamInExplore) {
    return (
      <div className="w-full">
        <PieceActionsOrTriggersList
          stepMetadataWithSuggestions={selectedQadamInExplore}
          hideQadamIconAndDescription={false}
          operation={operation}
        />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full w-full">
      <div className="flex  p-2  ">
        {categories.map((category) => (
          <div key={category.title} className="flex w-[50%] flex-col gap-0.5 ">
            <div className="text-sm text-muted-foreground mb-1.5">
              {category.title}
            </div>

            {category.metadata.map((qadamMetadata) => (
              <CardListItem
                className="rounded-sm py-3"
                key={qadamMetadata.displayName}
                onClick={() => setSelectedQadamInExplore(qadamMetadata)}
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
                </div>{' '}
              </CardListItem>
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
};

export { ExploreTabContent };
