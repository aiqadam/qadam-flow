import {
  QadamAuthProperty,
  QadamPropertyMap,
  piecePropertiesUtils,
} from '@aiqadam/qadams-framework';
import {
  FlowAction,
  FlowActionType,
  BranchOperator,
  CodeAction,
  QadamAction,
  QadamTrigger,
  FlowTrigger,
  deepMergeAndCast,
  BranchExecutionType,
  RouterExecutionType,
  isNil,
  flowStructureUtil,
  StepSettings,
  RouterActionSettingsWithValidation,
  FlowTriggerType,
  PropertyExecutionType,
  DEFAULT_SAMPLE_DATA_SETTINGS,
  FlowVersion,
  FlowOperationType,
  isManualQadamTrigger,
  AUTHENTICATION_PROPERTY_NAME,
} from '@aiqadam/shared';
import { useRef } from 'react';

import {
  QadamSelectorItem,
  QadamSelectorOperation,
  QadamSelectorQadamItem,
  QadamStepMetadataWithSuggestions,
} from '@/features/qadams/types';

import { formUtils } from './form-utils';
const defaultCode = `export const code = async (inputs) => {
  return true;
};`;

const removeHiddenActions = (
  qadamMetadata: QadamStepMetadataWithSuggestions,
) => {
  const actions = Object.values(qadamMetadata.suggestedActions ?? {});
  return actions;
};

const isPieceActionOrTrigger = (
  qadamSelectorItem: QadamSelectorItem,
): qadamSelectorItem is QadamSelectorQadamItem => {
  return (
    qadamSelectorItem.type === FlowActionType.PIECE ||
    (flowStructureUtil.isTrigger(qadamSelectorItem.type) &&
      qadamSelectorItem.type === FlowTriggerType.PIECE)
  );
};

const isPieceStepInputValid = ({
  props,
  auth,
  input,
  requireAuth,
}: {
  props: QadamPropertyMap;
  auth: QadamAuthProperty | QadamAuthProperty[] | undefined;
  input: Record<string, unknown>;
  requireAuth: boolean;
}): boolean => {
  const schema = piecePropertiesUtils.buildSchema(props, auth);
  const hasAuth = !isNil(auth);
  const authValid =
    !requireAuth || !hasAuth || !isNil(input[AUTHENTICATION_PROPERTY_NAME]);
  return schema.safeParse(input).success && authValid;
};

const isStepInitiallyValid = (
  qadamSelectorItem: QadamSelectorItem,
  overrideDefaultSettings?: StepSettings,
) => {
  switch (qadamSelectorItem.type) {
    case FlowActionType.CODE:
      return true;
    case FlowActionType.PIECE:
    case FlowTriggerType.PIECE: {
      const overridingInput =
        overrideDefaultSettings && 'input' in overrideDefaultSettings
          ? overrideDefaultSettings.input
          : undefined;
      const input = overridingInput ?? getInitalStepInput(qadamSelectorItem);
      return isPieceStepInputValid({
        props: qadamSelectorItem.actionOrTrigger.props,
        auth: qadamSelectorItem.qadamMetadata.auth,
        input,
        requireAuth: qadamSelectorItem.actionOrTrigger.requireAuth,
      });
    }
    case FlowActionType.LOOP_ON_ITEMS: {
      if (
        overrideDefaultSettings &&
        'input' in overrideDefaultSettings &&
        overrideDefaultSettings.input.items
      ) {
        return true;
      }
      return false;
    }
    case FlowTriggerType.EMPTY: {
      return false;
    }
    case FlowActionType.ROUTER: {
      if (overrideDefaultSettings) {
        return RouterActionSettingsWithValidation.safeParse(
          overrideDefaultSettings,
        ).success;
      }
      return false;
    }
  }
};

const getInitalStepInput = (qadamSelectorItem: QadamSelectorItem) => {
  if (!isPieceActionOrTrigger(qadamSelectorItem)) {
    return {};
  }
  return formUtils.getDefaultValueForProperties({
    props: {
      ...qadamSelectorItem.actionOrTrigger.props,
    },
    existingInput: {},
  });
};

const getDefaultStepValues = ({
  stepName,
  qadamSelectorItem,
  overrideDefaultSettings,
  customLogoUrl,
}: {
  stepName: string;
  qadamSelectorItem: QadamSelectorItem;
  overrideDefaultSettings?: StepSettings;
  customLogoUrl?: string;
}): FlowAction | FlowTrigger => {
  const errorHandlingOptions: CodeAction['settings']['errorHandlingOptions'] = {
    continueOnFailure: {
      value: false,
    },
    retryOnFailure: {
      value: false,
    },
  };

  const input = getInitalStepInput(qadamSelectorItem);
  const isValid = isStepInitiallyValid(
    qadamSelectorItem,
    overrideDefaultSettings,
  );
  const common = {
    name: stepName,
    valid: isValid,
    displayName: isPieceActionOrTrigger(qadamSelectorItem)
      ? qadamSelectorItem.actionOrTrigger.displayName
      : qadamSelectorItem.displayName,
    skip: false,
    settings: {
      customLogoUrl,
      sampleData: DEFAULT_SAMPLE_DATA_SETTINGS,
    },
  };

  switch (qadamSelectorItem.type) {
    case FlowActionType.CODE:
      return deepMergeAndCast<CodeAction>(
        {
          type: FlowActionType.CODE,
          settings: overrideDefaultSettings ?? {
            sourceCode: {
              code: defaultCode,
              packageJson: '{}',
            },
            input,
            errorHandlingOptions,
          },
        },
        common,
      );
    case FlowActionType.LOOP_ON_ITEMS:
      return deepMergeAndCast<FlowAction>(
        {
          type: FlowActionType.LOOP_ON_ITEMS,
          settings: overrideDefaultSettings ?? {
            items: '',
          },
        },
        common,
      );
    case FlowActionType.ROUTER:
      return deepMergeAndCast<FlowAction>(
        {
          type: FlowActionType.ROUTER,
          settings: overrideDefaultSettings ?? {
            executionType: RouterExecutionType.EXECUTE_FIRST_MATCH,
            branches: [
              {
                conditions: [
                  [
                    {
                      operator: BranchOperator.TEXT_EXACTLY_MATCHES,
                      firstValue: '',
                      secondValue: '',
                      caseSensitive: false,
                    },
                  ],
                ],
                branchType: BranchExecutionType.CONDITION,
                branchName: 'Branch 1',
              },
              {
                branchType: BranchExecutionType.FALLBACK,
                branchName: 'Otherwise',
              },
            ],
          },
          children: [null, null],
        },
        common,
      );
    case FlowActionType.PIECE: {
      if (!isPieceActionOrTrigger(qadamSelectorItem)) {
        throw new Error(
          `Invalid piece selector item ${JSON.stringify(qadamSelectorItem)}`,
        );
      }
      return deepMergeAndCast<QadamAction>(
        {
          type: FlowActionType.PIECE,
          settings: overrideDefaultSettings ?? {
            qadamName: qadamSelectorItem.qadamMetadata.qadamName,
            actionName: qadamSelectorItem.actionOrTrigger.name,
            qadamVersion: qadamSelectorItem.qadamMetadata.qadamVersion,
            input,
            errorHandlingOptions,
            propertySettings: Object.fromEntries(
              Object.entries(input).map(([key]) => [
                key,
                {
                  type: PropertyExecutionType.MANUAL,
                  schema: undefined,
                },
              ]),
            ),
          },
        },
        common,
      );
    }
    case FlowTriggerType.PIECE: {
      if (!isPieceActionOrTrigger(qadamSelectorItem)) {
        throw new Error(
          `Invalid piece selector item ${JSON.stringify(qadamSelectorItem)}`,
        );
      }
      return deepMergeAndCast<QadamTrigger>(
        {
          type: FlowTriggerType.PIECE,
          settings: overrideDefaultSettings ?? {
            qadamName: qadamSelectorItem.qadamMetadata.qadamName,
            triggerName: qadamSelectorItem.actionOrTrigger.name,
            qadamVersion: qadamSelectorItem.qadamMetadata.qadamVersion,
            input,
            propertySettings: Object.fromEntries(
              Object.entries(input).map(([key]) => [
                key,
                {
                  type: PropertyExecutionType.MANUAL,
                },
              ]),
            ),
          },
        },
        common,
      );
    }
    default:
      throw new Error('Unsupported type: ' + qadamSelectorItem.type);
  }
};

// Adjusts piece list height to prevent overflow on short screens
const useAdjustPieceListHeightToAvailableSpace = () => {
  const listHeightRef = useRef<number>(MAX_PIECE_SELECTOR_LIST_HEIGHT);
  const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);

  if (!popoverTriggerRef.current) {
    return {
      listHeightRef,
      popoverTriggerRef,
      searchInputDivHeight: SEARCH_INPUT_DIV_HEIGHT,
    };
  }

  const popOverTriggerRect = popoverTriggerRef.current.getBoundingClientRect();
  const viewportHeight =
    window.innerHeight || document.documentElement.clientHeight;
  const shouldRenderBelowPopoverTrigger =
    popOverTriggerRect.top < viewportHeight - popOverTriggerRect.bottom;

  if (shouldRenderBelowPopoverTrigger) {
    const availableSpaceBelow =
      viewportHeight - popOverTriggerRect.bottom - SEARCH_INPUT_DIV_HEIGHT;
    listHeightRef.current = Math.max(
      MIN_PIECE_SELECTOR_LIST_HEIGHT,
      availableSpaceBelow,
    );
  } else {
    const availableSpaceAbove =
      popOverTriggerRect.top - SEARCH_INPUT_DIV_HEIGHT;
    listHeightRef.current = Math.max(
      MIN_PIECE_SELECTOR_LIST_HEIGHT,
      availableSpaceAbove,
    );
  }

  return {
    listHeightRef,
    popoverTriggerRef,
  };
};
const MAX_PIECE_SELECTOR_LIST_HEIGHT = 300 as const;
const MIN_PIECE_SELECTOR_LIST_HEIGHT = 100 as const;
const SEARCH_INPUT_DIV_HEIGHT = 113 as const;
const PIECE_ITEM_HEIGHT = 48 as const;
const ACTION_OR_TRIGGER_ITEM_HEIGHT = 41 as const;
const CATEGORY_ITEM_HEIGHT = 28 as const;
export const PIECE_SELECTOR_ELEMENTS_HEIGHTS = {
  MAX_PIECE_SELECTOR_LIST_HEIGHT,
  MIN_PIECE_SELECTOR_LIST_HEIGHT,
  SEARCH_INPUT_DIV_HEIGHT,
  PIECE_ITEM_HEIGHT,
  ACTION_OR_TRIGGER_ITEM_HEIGHT,
  CATEGORY_ITEM_HEIGHT,
};

const isMcpToolTrigger = (qadamName: string, triggerName: string) => {
  return qadamName === '@aiqadam/qadam-mcp' && triggerName === 'mcp_tool';
};

const isChatTrigger = (qadamName: string, triggerName: string) => {
  return (
    qadamName === '@aiqadam/qadam-forms' && triggerName === 'chat_submission'
  );
};

const getStepNameFromOperationType = (
  operation: QadamSelectorOperation,
  flowVersion: FlowVersion,
) => {
  switch (operation.type) {
    case FlowOperationType.UPDATE_ACTION:
      return operation.stepName;
    case FlowOperationType.ADD_ACTION:
      return flowStructureUtil.findUnusedName(flowVersion.trigger);
    case FlowOperationType.UPDATE_TRIGGER:
      return 'trigger';
  }
};
export const qadamSelectorUtils = {
  getDefaultStepValues,
  useAdjustPieceListHeightToAvailableSpace,
  isPieceStepInputValid,
  isMcpToolTrigger,
  isChatTrigger,
  removeHiddenActions,
  getStepNameFromOperationType,
  isManualTrigger: isManualQadamTrigger,
};
