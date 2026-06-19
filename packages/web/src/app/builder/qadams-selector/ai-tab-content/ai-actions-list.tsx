import { ApFlagId, FlowActionType, TelemetryEventName } from '@aiqadam/shared';
import { t } from 'i18next';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { useTelemetry } from '@/components/providers/telemetry-provider';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  QadamSelectorOperation,
  StepMetadataWithSuggestions,
  useQadamSearchContext,
} from '@/features/qadams';
import { flagsHooks } from '@/hooks/flags-hooks';

import { useBuilderStateContext } from '../../builder-hooks';
import { convertStepMetadataToPieceSelectorItems } from '../qadam-actions-or-triggers-list';

import AIActionItem from './ai-action';

type AIPieceActionsListProps = {
  hideQadamIconAndDescription: boolean;
  stepMetadataWithSuggestions: StepMetadataWithSuggestions;
  operation: QadamSelectorOperation;
};

const ACTION_ICON_MAP: Record<string, string> = {
  run_agent: '/assets/qadams/new-core/agent.svg',
  generateImage: '/assets/qadams/new-core/image-ai.svg',
  askAi: '/assets/qadams/new-core/text-ai.svg',
  summarizeText: '/assets/qadams/new-core/text-ai.svg',
  classifyText: '/assets/qadams/new-core/text-ai.svg',
  extractStructuredData: '/assets/qadams/new-core/utility-ai.svg',
};

export const AIPieceActionsList: React.FC<AIPieceActionsListProps> = ({
  stepMetadataWithSuggestions,
  hideQadamIconAndDescription,
  operation,
}) => {
  const { capture } = useTelemetry();
  const { searchQuery } = useQadamSearchContext();
  const [handleAddingOrUpdatingStep] = useBuilderStateContext((state) => [
    state.handleAddingOrUpdatingStep,
  ]);
  const { data: isAgentsConfigured } = flagsHooks.useFlag<boolean>(
    ApFlagId.AGENTS_CONFIGURED,
  );
  const navigate = useNavigate();

  const aiActions = convertStepMetadataToPieceSelectorItems(
    stepMetadataWithSuggestions,
  );

  return (
    <ScrollArea className="h-full" viewPortClassName="h-full">
      <div className="grid grid-cols-3 p-2 gap-3 min-w-[350px]">
        {aiActions.map((item, index) => {
          const actionIcon =
            item.type === FlowActionType.PIECE
              ? ACTION_ICON_MAP[item.actionOrTrigger.name]
              : '/assets/qadams/new-core/image-ai.svg';
          return (
            <AIActionItem
              key={index}
              item={item}
              hideQadamIconAndDescription={hideQadamIconAndDescription}
              stepMetadataWithSuggestions={{
                ...stepMetadataWithSuggestions,
                logoUrl: actionIcon,
              }}
              onClick={() => {
                if (!isAgentsConfigured) {
                  toast('Connect to OpenAI', {
                    description: t(
                      "To create an agent, you'll first need to connect to OpenAI in platform settings.",
                    ),
                    action: {
                      label: 'Set Up',
                      onClick: () => {
                        navigate('/platform/setup/ai');
                      },
                    },
                  });
                  return;
                }

                if (item.type === FlowActionType.PIECE) {
                  capture({
                    name: TelemetryEventName.PIECE_SELECTOR_SEARCH,
                    payload: {
                      search: searchQuery,
                      isTrigger: false,
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
      </div>
    </ScrollArea>
  );
};
