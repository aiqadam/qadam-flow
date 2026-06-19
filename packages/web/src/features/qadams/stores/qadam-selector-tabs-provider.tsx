import { createContext, useContext, useState } from 'react';

import { StepMetadataWithSuggestions } from '@/features/qadams/types';

export enum QadamSelectorTabType {
  EXPLORE = 'EXPLORE',
  AI_AND_AGENTS = 'AI_AND_AGENTS',
  APPROVALS = 'APPROVALS',
  APPS = 'APPS',
  UTILITY = 'UTILITY',
  NONE = 'NONE',
}

export const QadamSelectorTabsContext = createContext({
  selectedTab: QadamSelectorTabType.EXPLORE,
  setSelectedTab: (_tab: QadamSelectorTabType) => {},
  resetToBeforeNoneWasSelected: () => {},
  setSelectedQadamInExplore: (_qadam: StepMetadataWithSuggestions | null) => {},
  selectedQadamInExplore: null as null | StepMetadataWithSuggestions,
});

export const QadamSelectorTabsProvider = ({
  children,
  onTabChange,
  initiallySelectedTab,
}: {
  children: React.ReactNode;
  onTabChange: (tab: QadamSelectorTabType) => void;
  initiallySelectedTab: QadamSelectorTabType;
}) => {
  const [selectedTab, setSelectedTab] = useState(initiallySelectedTab);
  const [lastTabBefroeNoneWasSelected, setLastTabBeforeNoneWasSelected] =
    useState(initiallySelectedTab);
  const [selectedQadamInExplore, setSelectedQadamInExplore] =
    useState<StepMetadataWithSuggestions | null>(null);
  return (
    <QadamSelectorTabsContext.Provider
      value={{
        selectedTab,
        setSelectedQadamInExplore,
        selectedQadamInExplore,
        setSelectedTab: (tab: QadamSelectorTabType) => {
          if (tab !== QadamSelectorTabType.NONE) {
            setLastTabBeforeNoneWasSelected(tab);
            onTabChange(tab);
          }
          setSelectedTab(tab);
        },
        resetToBeforeNoneWasSelected: () => {
          setSelectedTab(lastTabBefroeNoneWasSelected);
        },
      }}
    >
      {children}
    </QadamSelectorTabsContext.Provider>
  );
};

export const useQadamSelectorTabs = () => {
  const context = useContext(QadamSelectorTabsContext);
  if (!context) {
    throw new Error(
      'useQadamSelectorTabs must be used within a QadamSelectorTabsProvider',
    );
  }
  return context;
};
