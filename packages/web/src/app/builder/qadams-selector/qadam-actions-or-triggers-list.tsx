import {
  FlowActionType,
  isNil,
  FlowTriggerType,
  TelemetryEventName,
} from '@aiqadam/shared';
import { t } from 'i18next';
import { MoveLeft } from 'lucide-react';
import React from 'react';

import { CardList } from '@/components/custom/card-list';
import { useTelemetry } from '@/components/providers/telemetry-provider';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  QadamSelectorItem,
  QadamSelectorOperation,
  StepMetadataWithSuggestions,
  qadamSelectorUtils,
  CORE_ACTIONS_METADATA,
  useQadamSearchContext,
} from '@/features/qadams';

import { useBuilderStateContext } from '../builder-hooks';

import GenericActionOrTriggerItem from './generic-qadam-selector-item';
type PieceActionsOrTriggersListProps = {
  hideQadamIconAndDescription: boolean;
  stepMetadataWithSuggestions: StepMetadataWithSuggestions | null;
  operation: QadamSelectorOperation;
};
export const convertStepMetadataToPieceSelectorItems = (
  stepMetadataWithSuggestions: StepMetadataWithSuggestions,
): QadamSelectorItem[] => {
  switch (stepMetadataWithSuggestions.type) {
    case FlowActionType.PIECE: {
      const actions = qadamSelectorUtils.removeHiddenActions(
        stepMetadataWithSuggestions,
      );
      return actions.map((action) => ({
        actionOrTrigger: action,
        type: FlowActionType.PIECE,
        qadamMetadata: stepMetadataWithSuggestions,
      }));
    }
    case FlowTriggerType.PIECE: {
      const triggers = Object.values(
        stepMetadataWithSuggestions.suggestedTriggers ?? {},
      );
      return triggers.map((trigger) => ({
        actionOrTrigger: trigger,
        type: FlowTriggerType.PIECE,
        qadamMetadata: stepMetadataWithSuggestions,
      }));
    }
    case FlowActionType.CODE:
    case FlowActionType.LOOP_ON_ITEMS:
    case FlowActionType.ROUTER: {
      return CORE_ACTIONS_METADATA.filter(
        (step) => step.type === stepMetadataWithSuggestions.type,
      );
    }
    default: {
      return [];
    }
  }
};

export const PieceActionsOrTriggersList: React.FC<
  PieceActionsOrTriggersListProps
> = ({
  stepMetadataWithSuggestions,
  hideQadamIconAndDescription,
  operation,
}) => {
  const { capture } = useTelemetry();
  const { searchQuery } = useQadamSearchContext();
  const [handleAddingOrUpdatingStep] = useBuilderStateContext((state) => [
    state.handleAddingOrUpdatingStep,
  ]);
  if (isNil(stepMetadataWithSuggestions)) {
    return (
      <div className="flex flex-col gap-2 items-center justify-center h-full w-full">
        <MoveLeft className="w-10 h-10 rtl:rotate-180" />
        <div className="text-sm">{t('Please select a qadam first')}</div>
      </div>
    );
  }

  const actionsOrTriggers = convertStepMetadataToPieceSelectorItems(
    stepMetadataWithSuggestions,
  );
  return (
    <ScrollArea className="h-full" viewPortClassName="h-full">
      <CardList className="min-w-[350px] h-full gap-0" listClassName="gap-0">
        {actionsOrTriggers &&
          actionsOrTriggers.map((item, index) => {
            return (
              <GenericActionOrTriggerItem
                key={index}
                item={item}
                hideQadamIconAndDescription={hideQadamIconAndDescription}
                stepMetadataWithSuggestions={stepMetadataWithSuggestions}
                onClick={() => {
                  if (
                    item.type === FlowActionType.PIECE ||
                    item.type === FlowTriggerType.PIECE
                  ) {
                    capture({
                      name: TelemetryEventName.PIECE_SELECTOR_SEARCH,
                      payload: {
                        search: searchQuery,
                        isTrigger: item.type === FlowTriggerType.PIECE,
                        selectedActionOrTriggerName: item.actionOrTrigger.name,
                      },
                    });
                  }

                  handleAddingOrUpdatingStep({
                    qadamSelectorItem: item,
                    operation,
                    selectStepAfter: true,
                  });
                }}
              />
            );
          })}
      </CardList>
    </ScrollArea>
  );
};
