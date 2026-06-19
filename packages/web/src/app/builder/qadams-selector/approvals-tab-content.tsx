import { FlowActionType, FlowOperationType, isNil } from '@aiqadam/shared';

import { CardList, CardListItemSkeleton } from '@/components/custom/card-list';
import {
  qadamsHooks,
  QadamSelectorTabType,
  useQadamSelectorTabs,
  QadamSelectorOperation,
  stepUtils,
} from '@/features/qadams';

import { useBuilderStateContext } from '../builder-hooks';

import GenericActionOrTriggerItem from './generic-qadam-selector-item';

const APPROVAL_PIECES_CONFIG = [
  {
    qadamName: '@aiqadam/qadam-slack',
    approvalActionNames: [
      'request_approval_message',
      'request_approval_direct_message',
    ],
  },
  {
    qadamName: '@aiqadam/qadam-discord',
    approvalActionNames: ['request_approval_message'],
  },
  {
    qadamName: '@aiqadam/qadam-microsoft-teams',
    approvalActionNames: [
      'request_approval_direct_message',
      'request_approval_in_channel',
    ],
  },
  {
    qadamName: '@aiqadam/qadam-microsoft-outlook',
    approvalActionNames: ['request_approval_in_mail'],
  },
  {
    qadamName: '@aiqadam/qadam-gmail',
    approvalActionNames: ['request_approval_in_mail'],
  },
  {
    qadamName: '@aiqadam/qadam-telegram-bot',
    approvalActionNames: ['request_approval_message'],
  },
];

const ApprovalsTabContent = ({
  operation,
}: {
  operation: QadamSelectorOperation;
}) => {
  const { selectedTab } = useQadamSelectorTabs();
  const [handleAddingOrUpdatingStep] = useBuilderStateContext((state) => [
    state.handleAddingOrUpdatingStep,
  ]);

  const pieceQueries = qadamsHooks.useMultipleQadams({
    names: APPROVAL_PIECES_CONFIG.map((config) => config.qadamName),
  });

  const isLoading = pieceQueries.some((query) => query.isLoading);
  const allPiecesLoaded = pieceQueries.every(
    (query) => query.isSuccess && !isNil(query.data),
  );

  if (
    selectedTab !== QadamSelectorTabType.APPROVALS ||
    ![FlowOperationType.ADD_ACTION, FlowOperationType.UPDATE_ACTION].includes(
      operation.type,
    )
  ) {
    return null;
  }

  if (isLoading || !allPiecesLoaded) {
    return (
      <div className="flex flex-col gap-2 w-full p-2">
        <CardListItemSkeleton numberOfCards={3} withCircle={false} />
      </div>
    );
  }

  const allApprovalActions = pieceQueries.flatMap((query) => {
    if (!query.data) return [];

    const config = APPROVAL_PIECES_CONFIG.find(
      (config) => config.qadamName === query.data.name,
    );
    if (isNil(config)) return [];
    const qadamMetadata = stepUtils.mapPieceToMetadata({
      piece: query.data,
      type: 'action',
    });

    return config.approvalActionNames
      .map((actionName) => {
        const action = query.data.actions[actionName];
        if (!action) return null;
        return {
          action,
          qadamMetadata,
        };
      })
      .filter((item) => !isNil(item));
  });

  return (
    <CardList listClassName="gap-0">
      {allApprovalActions.map((item) => (
        <GenericActionOrTriggerItem
          key={`${item.qadamMetadata.qadamName}-${item.action.name}`}
          item={{
            actionOrTrigger: item.action,
            type: FlowActionType.PIECE,
            qadamMetadata: item.qadamMetadata,
          }}
          hideQadamIconAndDescription={false}
          stepMetadataWithSuggestions={{
            ...item.qadamMetadata,
            suggestedActions: [item.action],
            suggestedTriggers: [],
          }}
          onClick={() => {
            handleAddingOrUpdatingStep({
              qadamSelectorItem: {
                actionOrTrigger: item.action,
                type: FlowActionType.PIECE,
                qadamMetadata: item.qadamMetadata,
              },
              operation,
              selectStepAfter: true,
            });
          }}
        />
      ))}
    </CardList>
  );
};

export { ApprovalsTabContent };
