import { t } from 'i18next';
import { ArrowLeftIcon } from 'lucide-react';

import { SearchInput } from '@/components/custom/search-input';
import { Button } from '@/components/ui/button';
import { useQadamSearchContext } from '@/features/qadams/stores/qadam-search-context';
import {
  QadamSelectorTabType,
  useQadamSelectorTabs,
} from '@/features/qadams/stores/qadam-selector-tabs-provider';

type QadamsSearchInputProps = {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchChange: (query: string) => void;
};

const QadamsSearchInput = ({
  searchInputRef,
  onSearchChange,
}: QadamsSearchInputProps) => {
  const { searchQuery, setSearchQuery } = useQadamSearchContext();
  const {
    resetToBeforeNoneWasSelected: resetToPreviousValue,
    setSelectedTab,
    selectedQadamInExplore,
    selectedTab,
    setSelectedQadamInExplore,
  } = useQadamSelectorTabs();
  const showBackButton =
    selectedQadamInExplore && selectedTab === QadamSelectorTabType.EXPLORE;
  return (
    <div className="p-2 flex gap-2 items-center">
      {showBackButton && (
        <Button
          variant="ghost"
          size="icon"
          onClick={() => {
            setSelectedQadamInExplore(null);
          }}
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
      )}
      <SearchInput
        placeholder={t('Search')}
        value={searchQuery}
        data-testid="qadams-search-input"
        ref={searchInputRef}
        onChange={(e) => {
          setSearchQuery(e);
          onSearchChange(e);
          if (e === '') {
            resetToPreviousValue();
          } else {
            setSelectedTab(QadamSelectorTabType.NONE);
          }
        }}
      />
    </div>
  );
};
QadamsSearchInput.displayName = 'QadamsSearchInput';
export { QadamsSearchInput };
