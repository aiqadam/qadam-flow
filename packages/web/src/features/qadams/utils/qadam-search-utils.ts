import {
  QadamCategory,
  FlowTriggerType,
  FlowActionType,
  AI_PIECE_NAME,
} from '@aiqadam/shared';
import { t } from 'i18next';

import {
  CategorizedStepMetadataWithSuggestions,
  QadamStepMetadataWithSuggestions,
  StepMetadata,
  StepMetadataWithSuggestions,
} from '@/features/qadams/types';

const isFlowController = (stepMetadata: StepMetadata) => {
  if (
    stepMetadata.type === FlowActionType.PIECE ||
    stepMetadata.type === FlowTriggerType.PIECE
  ) {
    return stepMetadata.categories.includes(QadamCategory.FLOW_CONTROL);
  }
  return (
    stepMetadata.type === FlowActionType.LOOP_ON_ITEMS ||
    stepMetadata.type === FlowActionType.ROUTER
  );
};

const getAiAndAgentsPieces = (queryResult: StepMetadataWithSuggestions[]) => {
  const res: CategorizedStepMetadataWithSuggestions[] = [];
  const pieces = filterResultByQadamType(queryResult);
  const aiAndAgentsPieces = pieces.filter(isAiAndAgentPiece);
  const recommendedCategory: CategorizedStepMetadataWithSuggestions = {
    title: t('Recommended'),
    metadata: [],
  };
  const othersCategory: CategorizedStepMetadataWithSuggestions = {
    title: t('Others'),
    metadata: [],
  };
  const recommendedPieces = aiAndAgentsPieces.filter((piece) =>
    piece.categories.includes(QadamCategory.UNIVERSAL_AI),
  );
  if (recommendedPieces.length > 0) {
    recommendedCategory.metadata = recommendedPieces;
    res.push(recommendedCategory);
  }
  const otherPieces = aiAndAgentsPieces.filter(
    (piece) => !recommendedPieces.includes(piece),
  );
  if (otherPieces.length > 0) {
    othersCategory.metadata = otherPieces;
    res.push(othersCategory);
  }
  return res;
};

const isAiAndAgentPiece = (stepMetadata: StepMetadata) => {
  if (
    stepMetadata.type === FlowActionType.PIECE ||
    stepMetadata.type === FlowTriggerType.PIECE
  ) {
    return stepMetadata.categories.some((category) =>
      [
        QadamCategory.UNIVERSAL_AI,
        QadamCategory.ARTIFICIAL_INTELLIGENCE,
      ].includes(category as QadamCategory),
    );
  }
  return false;
};

const isUtilityPiece = (metadata: StepMetadata) =>
  metadata.type !== FlowTriggerType.PIECE &&
  metadata.type !== FlowActionType.PIECE
    ? !isFlowController(metadata)
    : metadata.categories.includes(QadamCategory.CORE) &&
      !isFlowController(metadata);

const isAppPiece = (metadata: StepMetadata) => {
  return (
    !isUtilityPiece(metadata) &&
    !isAiAndAgentPiece(metadata) &&
    !isFlowController(metadata)
  );
};

const getPinnedPieces = (
  queryResult: StepMetadataWithSuggestions[],
  pinnedPiecesNames: string[],
) => {
  const pieces = filterResultByQadamType(queryResult);
  const pinnedPieces = pieces.filter((piece) =>
    pinnedPiecesNames.includes(piece.qadamName),
  );
  return sortByPieceNameOrder(pinnedPieces, pinnedPiecesNames);
};

const POPULAR_PIECES_NAMES = [
  '@aiqadam/qadam-google-sheets',
  '@aiqadam/qadam-slack',
  '@aiqadam/qadam-notion',
  '@aiqadam/qadam-gmail',
  '@aiqadam/qadam-hubspot',
  '@aiqadam/qadam-openai',
  '@aiqadam/qadam-google-forms',
  '@aiqadam/qadam-google-drive',
  '@aiqadam/qadam-google-docs',
];
const getPopularPieces = (
  queryResult: StepMetadataWithSuggestions[],
  pinnedPiecesNames: string[],
) => {
  const pieces = filterResultByQadamType(queryResult);
  const popularPieces = pieces.filter(
    (piece) =>
      POPULAR_PIECES_NAMES.includes(piece.qadamName) &&
      !pinnedPiecesNames.includes(piece.qadamName),
  );
  return sortByPieceNameOrder(popularPieces, POPULAR_PIECES_NAMES);
};

const filterResultByQadamType = (
  queryResult: StepMetadataWithSuggestions[],
) => {
  return queryResult.filter(
    (piece): piece is QadamStepMetadataWithSuggestions =>
      piece.type === FlowActionType.PIECE ||
      piece.type === FlowTriggerType.PIECE,
  );
};

const getHighlightedPieces = (
  queryResult: StepMetadataWithSuggestions[],
  type: 'action' | 'trigger',
) => {
  const pieces = filterResultByQadamType(queryResult);
  const highlightedPiecesNames =
    type === 'action'
      ? HIGHLIGHTED_PIECES_NAMES_FOR_ACTIONS
      : HIGHLIGHTED_PIECES_NAMES_FOR_TRIGGERS;
  const highlightedPieces = pieces.filter((piece) =>
    highlightedPiecesNames.includes(piece.qadamName),
  );
  return sortByPieceNameOrder(
    highlightedPieces,
    type === 'action'
      ? HIGHLIGHTED_PIECES_NAMES_FOR_ACTIONS
      : HIGHLIGHTED_PIECES_NAMES_FOR_TRIGGERS,
  );
};
const sortByPieceNameOrder = (
  searchResult: StepMetadataWithSuggestions[],
  orderNames: string[],
): StepMetadataWithSuggestions[] => {
  const pieces = filterResultByQadamType(searchResult);
  return pieces.sort((a, b) => {
    return orderNames.indexOf(a.qadamName) - orderNames.indexOf(b.qadamName);
  });
};
const HIGHLIGHTED_PIECES_NAMES_FOR_TRIGGERS = [
  '@aiqadam/qadam-webhook',
  '@aiqadam/qadam-schedule',
  '@aiqadam/qadam-manual-trigger',
  '@aiqadam/qadam-forms',
  '@aiqadam/qadam-tables',
];

const HIGHLIGHTED_PIECES_NAMES_FOR_ACTIONS = [
  AI_PIECE_NAME,
  '@aiqadam/qadam-http',
  '@aiqadam/qadam-tables',
  '@aiqadam/qadam-forms',
  '@aiqadam/qadam-webhook',
  '@aiqadam/qadam-text-helper',
  '@aiqadam/qadam-date-helper',
];

export const qadamSearchUtils = {
  isFlowController,
  getAiAndAgentsPieces,
  isAiAndAgentPiece,
  isUtilityPiece,
  isAppPiece,
  getPinnedPieces,
  getPopularPieces,
  getHighlightedPieces,
};
