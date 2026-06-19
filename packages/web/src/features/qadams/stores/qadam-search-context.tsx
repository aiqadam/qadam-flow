import { createContext, useContext, useState } from 'react';

export type QadamSearchContextState = {
  searchQuery: string;
  setSearchQuery: (searchQuery: string) => void;
};

const QadamSearchContext = createContext<QadamSearchContextState>({
  searchQuery: '',
  setSearchQuery: () => {},
});

export const QadamSearchProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  return (
    <QadamSearchContext.Provider value={{ searchQuery, setSearchQuery }}>
      {children}
    </QadamSearchContext.Provider>
  );
};

export const useQadamSearchContext = () => useContext(QadamSearchContext);
