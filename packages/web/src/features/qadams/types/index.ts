import {
  ActionBase,
  ErrorHandlingOptionsParam,
  QadamAuthProperty,
  QadamMetadataModelSummary,
  TriggerBase,
} from '@aiqadam/qadams-framework';
import {
  FlowActionType,
  PackageType,
  QadamType,
  FlowTriggerType,
  FlowOperationType,
  StepLocationRelativeToParent,
} from '@aiqadam/shared';

type BaseStepMetadata = {
  displayName: string;
  logoUrl: string;
  description: string;
};

export type QadamStepMetadata = BaseStepMetadata & {
  type: FlowActionType.PIECE | FlowTriggerType.PIECE;
  qadamName: string;
  qadamVersion: string;
  categories: string[];
  packageType: PackageType;
  qadamType: QadamType;
  auth: QadamAuthProperty | QadamAuthProperty[] | undefined;
  errorHandlingOptions?: ErrorHandlingOptionsParam;
};

export type PrimitiveStepMetadata = BaseStepMetadata & {
  type:
    | FlowActionType.CODE
    | FlowActionType.LOOP_ON_ITEMS
    | FlowActionType.ROUTER
    | FlowTriggerType.EMPTY;
};

export type QadamStepMetadataWithSuggestions = QadamStepMetadata &
  Pick<QadamMetadataModelSummary, 'suggestedActions' | 'suggestedTriggers'>;

export type StepMetadataWithSuggestions =
  | QadamStepMetadataWithSuggestions
  | PrimitiveStepMetadata;

export type CategorizedStepMetadataWithSuggestions = {
  title: string;
  metadata: StepMetadataWithSuggestions[];
};

export type StepMetadata = QadamStepMetadata | PrimitiveStepMetadata;

export type StepMetadataWithActionOrTriggerOrAgentDisplayName = StepMetadata & {
  actionOrTriggerOrAgentDisplayName: string;
  actionOrTriggerOrAgentDescription: string;
};

export type QadamSelectorOperation =
  | {
      type: FlowOperationType.ADD_ACTION;
      actionLocation: {
        branchIndex: number;
        parentStep: string;
        stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH;
      };
    }
  | {
      type: FlowOperationType.ADD_ACTION;
      actionLocation: {
        parentStep: string;
        stepLocationRelativeToParent: Exclude<
          StepLocationRelativeToParent,
          StepLocationRelativeToParent.INSIDE_BRANCH
        >;
      };
    }
  | { type: FlowOperationType.UPDATE_TRIGGER }
  | {
      type: FlowOperationType.UPDATE_ACTION;
      stepName: string;
    };

export type QadamSelectorQadamItem =
  | {
      actionOrTrigger: TriggerBase;
      type: FlowTriggerType.PIECE;
      qadamMetadata: QadamStepMetadata;
    }
  | ({
      actionOrTrigger: ActionBase;
      type: FlowActionType.PIECE;
      qadamMetadata: QadamStepMetadata;
    } & {
      auth?: QadamAuthProperty;
    });

export type QadamSelectorItem = QadamSelectorQadamItem | PrimitiveStepMetadata;

export type HandleSelectActionOrTrigger = (item: QadamSelectorItem) => void;
