import { createContext, useContext, useRef } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';

import { ChatStore, ChatStoreState, createChatStore } from './chat-store';

const ChatStoreContext = createContext<ChatStore | null>(null);

export function ChatStoreProvider({ children }: { children: React.ReactNode }) {
  const storeRef = useRef<ChatStore>(null);
  if (!storeRef.current) {
    storeRef.current = createChatStore();
  }
  return (
    <ChatStoreContext.Provider value={storeRef.current}>
      {children}
    </ChatStoreContext.Provider>
  );
}

export function useChatStoreContext<T>(
  selector: (state: ChatStoreState) => T,
): T {
  const store = useContext(ChatStoreContext);
  if (!store)
    throw new Error(
      'useChatStoreContext must be used within ChatStoreProvider',
    );
  return useStore(store, useShallow(selector));
}

export function useChatStoreApi(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (!store)
    throw new Error('useChatStoreApi must be used within ChatStoreProvider');
  return store;
}
