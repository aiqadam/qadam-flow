import { FlowOperationType, FlowTriggerType, isNil } from '@aiqadam/shared';
import { t } from 'i18next';
import {
  CheckCircle2Icon,
  LayoutGridIcon,
  PuzzleIcon,
  SparklesIcon,
  WrenchIcon,
} from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { useDebounce } from 'use-debounce';

import { useBuilderStateContext } from '@/app/builder/builder-hooks';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { aiProviderQueries } from '@/features/platform-admin';
import {
  QadamsSearchInput,
  QadamSelectorTabs,
  QadamSelectorTabsProvider,
  QadamSelectorTabType,
  QadamSelectorOperation,
  qadamSelectorUtils,
  QadamSearchProvider,
  useQadamSearchContext,
} from '@/features/qadams';
import { platformHooks } from '@/hooks/platform-hooks';
import { useIsMobile } from '@/hooks/use-mobile';

import { AITabContent } from './ai-tab-content';
import { ApprovalsTabContent } from './approvals-tab-content';
import { ExploreTabContent } from './explore-tab-content';
import { PiecesCardList } from './qadams-card-list';

const getTabsList = (
  operationType: FlowOperationType,
  agentsEnabled: boolean,
) => {
  const baseTabs = [
    {
      value: QadamSelectorTabType.EXPLORE,
      name: t('Explore'),
      icon: <LayoutGridIcon className="size-5" />,
    },
    {
      value: QadamSelectorTabType.APPS,
      name: t('Apps'),
      icon: <PuzzleIcon className="size-5" />,
    },
    {
      value: QadamSelectorTabType.UTILITY,
      name: t('Utility'),
      icon: <WrenchIcon className="size-5" />,
    },
  ];

  const replaceOrAddAction = [
    FlowOperationType.ADD_ACTION,
    FlowOperationType.UPDATE_ACTION,
  ].includes(operationType);

  if (replaceOrAddAction && agentsEnabled) {
    baseTabs.splice(1, 0, {
      value: QadamSelectorTabType.AI_AND_AGENTS,
      name: t('AI & Agents'),
      icon: <SparklesIcon className="size-5" />,
    });
  }
  if (replaceOrAddAction) {
    baseTabs.push({
      value: QadamSelectorTabType.APPROVALS,
      name: t('Approvals'),
      icon: <CheckCircle2Icon className="size-5" />,
    });
  }
  return baseTabs;
};

type PieceSelectorProps = {
  children: React.ReactNode;
  id: string;
  operation: QadamSelectorOperation;
  openSelectorOnClick?: boolean;
  stepToReplaceQadamDisplayName?: string;
};

const PieceSelectorWrapper = (props: PieceSelectorProps) => {
  return (
    <QadamSearchProvider>
      <PieceSelectorContent {...props} />
    </QadamSearchProvider>
  );
};

const PieceSelectorContent = ({
  children,
  operation,
  id,
  openSelectorOnClick = true,
  stepToReplaceQadamDisplayName,
}: PieceSelectorProps) => {
  const [
    openedQadamSelectorStepNameOrAddButtonId,
    setOpenedQadamSelectorStepNameOrAddButtonId,
    setSelectedQadamMetadataInQadamSelector,
    isForEmptyTrigger,
    deselectStep,
  ] = useBuilderStateContext((state) => [
    state.openedQadamSelectorStepNameOrAddButtonId,
    state.setOpenedQadamSelectorStepNameOrAddButtonId,
    state.setSelectedQadamMetadataInQadamSelector,
    state.flowVersion.trigger.type === FlowTriggerType.EMPTY &&
      id === 'trigger',
    state.deselectStep,
  ]);
  const { searchQuery, setSearchQuery } = useQadamSearchContext();
  const isForReplace =
    operation.type === FlowOperationType.UPDATE_ACTION ||
    (operation.type === FlowOperationType.UPDATE_TRIGGER && !isForEmptyTrigger);
  const [debouncedQuery] = useDebounce(searchQuery, 300);
  const isOpen = openedQadamSelectorStepNameOrAddButtonId === id;
  const isMobile = useIsMobile();
  const { listHeightRef, popoverTriggerRef } =
    qadamSelectorUtils.useAdjustPieceListHeightToAvailableSpace();
  const listHeight = Math.min(listHeightRef.current, 300);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [isOpen]);
  const { data: aiProviders } = aiProviderQueries.useAiProviders();
  const clearSearch = () => {
    setSearchQuery('');
    setSelectedQadamMetadataInQadamSelector(null);
  };

  const { platform } = platformHooks.useCurrentPlatform();
  const tabsList = getTabsList(
    operation.type,
    platform.plan.agentsEnabled &&
      !isNil(aiProviders) &&
      aiProviders.length > 0,
  );

  return (
    <Popover
      open={isOpen}
      modal={true}
      onOpenChange={(open) => {
        if (!open) {
          clearSearch();
          setOpenedQadamSelectorStepNameOrAddButtonId(null);
          if (isForEmptyTrigger) {
            deselectStep();
          }
        }
      }}
    >
      <PopoverTrigger
        ref={popoverTriggerRef}
        asChild={true}
        onClick={() => {
          if (openSelectorOnClick) {
            setOpenedQadamSelectorStepNameOrAddButtonId(id);
          }
        }}
      >
        {children}
      </PopoverTrigger>

      <QadamSelectorTabsProvider
        initiallySelectedTab={
          isForReplace || isMobile
            ? QadamSelectorTabType.NONE
            : QadamSelectorTabType.EXPLORE
        }
        onTabChange={clearSearch}
        key={isOpen ? 'open' : 'closed'}
      >
        <PopoverContent
          onContextMenu={(e) => {
            e.stopPropagation();
          }}
          className="w-[340px] md:w-[600px] p-0 shadow-lg"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
          }}
        >
          <>
            <div>
              <QadamsSearchInput
                searchInputRef={searchInputRef}
                onSearchChange={(e) => {
                  setSelectedQadamMetadataInQadamSelector(null);
                  if (e === '') {
                    clearSearch();
                  }
                }}
              />
              {!isMobile && <QadamSelectorTabs tabs={tabsList} />}
              <Separator orientation="horizontal" className="mt-1" />
            </div>
            <div
              className=" flex flex-row max-h-[300px]"
              style={{
                height: listHeight + 'px',
              }}
            >
              <ExploreTabContent operation={operation} />
              <AITabContent operation={operation} />
              <ApprovalsTabContent operation={operation} />

              <PiecesCardList
                //this is done to avoid debounced results when user clears search
                searchQuery={searchQuery === '' ? '' : debouncedQuery}
                operation={operation}
                stepToReplaceQadamDisplayName={
                  isMobile ? undefined : stepToReplaceQadamDisplayName
                }
              />
            </div>
          </>
        </PopoverContent>
      </QadamSelectorTabsProvider>
    </Popover>
  );
};

export { PieceSelectorWrapper as PieceSelector };
