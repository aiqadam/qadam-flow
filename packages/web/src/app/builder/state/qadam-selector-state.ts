import { FlowTriggerType } from '@aiqadam/shared';
import { StoreApi } from 'zustand';

import { RightSideBarType } from '@/app/builder/types';
import { StepMetadataWithSuggestions } from '@/features/qadams';

import { BuilderState } from '../builder-hooks';

export type QadamSelectorState = {
  openedQadamSelectorStepNameOrAddButtonId: string | null;
  setOpenedQadamSelectorStepNameOrAddButtonId: (
    stepNameOrAddButtonId: string | null,
  ) => void;
  selectedQadamMetadataInQadamSelector: StepMetadataWithSuggestions | null;
  setSelectedQadamMetadataInQadamSelector: (
    metadata: StepMetadataWithSuggestions | null,
  ) => void;
};

export const createQadamSelectorState = (
  _: StoreApi<BuilderState>['getState'],
  set: StoreApi<BuilderState>['setState'],
): QadamSelectorState => {
  return {
    openedQadamSelectorStepNameOrAddButtonId: null,
    setOpenedQadamSelectorStepNameOrAddButtonId: (
      stepNameOrAddButtonId: string | null,
    ) => {
      return set((state) => {
        const isReplacingEmptyTrigger =
          state.flowVersion.trigger.type === FlowTriggerType.EMPTY &&
          stepNameOrAddButtonId === 'trigger';
        return {
          openedQadamSelectorStepNameOrAddButtonId: stepNameOrAddButtonId,
          rightSidebar: isReplacingEmptyTrigger
            ? RightSideBarType.NONE
            : state.rightSidebar,
        };
      });
    },
    selectedQadamMetadataInQadamSelector: null,
    setSelectedQadamMetadataInQadamSelector: (
      metadata: StepMetadataWithSuggestions | null,
    ) => {
      return set(() => ({
        selectedQadamMetadataInQadamSelector: metadata,
      }));
    },
  };
};
