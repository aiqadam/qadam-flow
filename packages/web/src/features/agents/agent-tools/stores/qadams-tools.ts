import { ActionBase } from '@aiqadam/qadams-framework';
import {
  AgentQadamTool,
  AgentToolType,
  isNil,
  PredefinedInputsStructure,
  mcpToolNameUtils,
} from '@aiqadam/shared';
import { create } from 'zustand';

import { QadamStepMetadataWithSuggestions } from '@/features/qadams/types';

type SelectedDialogPage = 'qadams-list' | 'actions-list' | 'action-inputs';

interface QadamsToolDialogsState {
  showAddQadamDialog: boolean;
  selectedPage: SelectedDialogPage;
  searchQuery: string;
  selectedQadam?: QadamStepMetadataWithSuggestions;
  selectedAction?: ActionBase;
  predefinedInputs?: PredefinedInputsStructure;
  editingQadamTool?: AgentQadamTool;

  setSelectedPage: (page: SelectedDialogPage) => void;
  setSearchQuery: (query: string) => void;
  setPredefinedInputs: (inputs: PredefinedInputsStructure) => void;

  openAddQadamToolDialog: ({
    page,
    tool,
    piece,
  }: {
    page?: SelectedDialogPage;
    tool?: AgentQadamTool;
    piece?: QadamStepMetadataWithSuggestions;
  }) => void;

  handleQadamSelect: (piece: QadamStepMetadataWithSuggestions) => void;
  handleActionSelect: (action: ActionBase) => void;
  goBackToQadamsList: () => void;
  goBackToActionsList: () => void;

  isQadamAuthSet: () => boolean;

  createNewQadamTool: () => AgentQadamTool | null;
  closeQadamDialog: () => void;
  resetDialogState: () => void;
}

const initialState = {
  showAddQadamDialog: false,
  selectedPage: 'qadams-list' as SelectedDialogPage,
  searchQuery: '',
  selectedQadam: undefined,
  selectedAction: undefined,
  predefinedInputs: undefined,
  editingQadamTool: undefined,
};

export const useQadamToolsDialogStore = create<QadamsToolDialogsState>(
  (set, get) => ({
    ...initialState,

    setSelectedPage: (page) => set({ selectedPage: page }),
    setSearchQuery: (query) => set({ searchQuery: query }),
    setPredefinedInputs: (inputs) => set({ predefinedInputs: inputs }),
    openAddQadamToolDialog: ({ page = 'qadams-list', tool, piece }) => {
      set({
        showAddQadamDialog: true,
        selectedPage: page,
        editingQadamTool: tool,
        predefinedInputs: tool?.pieceMetadata.predefinedInput,
        selectedQadam: piece,
      });
    },
    handleQadamSelect: (piece) => {
      set({
        selectedQadam: piece,
        selectedPage: 'actions-list',
      });
    },
    handleActionSelect: (action) => {
      set({
        selectedAction: action,
        selectedPage: 'action-inputs',
      });
    },
    goBackToQadamsList: () => {
      set({
        selectedPage: 'qadams-list',
      });
      get().resetDialogState();
    },
    goBackToActionsList: () => {
      set({
        selectedPage: 'actions-list',
        selectedAction: undefined,
        predefinedInputs: undefined,
      });
    },
    isQadamAuthSet: () => {
      const { selectedQadam, selectedAction, predefinedInputs } = get();

      if (isNil(selectedQadam) || isNil(selectedAction)) {
        return false;
      }

      if (!selectedAction.requireAuth || isNil(selectedQadam.auth)) {
        return true;
      }

      if (!isNil(predefinedInputs?.auth)) {
        return true;
      }

      return false;
    },
    createNewQadamTool: () => {
      const {
        selectedAction,
        selectedQadam,
        predefinedInputs,
        isQadamAuthSet,
      } = get();

      if (!selectedAction || !selectedQadam || !isQadamAuthSet()) {
        return null;
      }

      return {
        type: AgentToolType.PIECE,
        toolName: mcpToolNameUtils.createQadamToolName(
          selectedQadam.qadamName,
          selectedAction.name,
        ),
        pieceMetadata: {
          qadamVersion: selectedQadam.qadamVersion,
          qadamName: selectedQadam.qadamName,
          actionName: selectedAction.name,
          predefinedInput: predefinedInputs || undefined,
        },
      };
    },
    resetDialogState: () => {
      set({
        searchQuery: '',
        selectedQadam: undefined,
        selectedAction: undefined,
        predefinedInputs: undefined,
        editingQadamTool: undefined,
        selectedPage: 'qadams-list',
      });
    },
    closeQadamDialog: () => {
      set({ showAddQadamDialog: false });
      get().resetDialogState();
    },
  }),
);
