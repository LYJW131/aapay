import { createContext, use, useSyncExternalStore } from 'react';
import type { AssistantStore } from './store.ts';

export const StoreContext = createContext<AssistantStore | null>(null);

export function useChatStore() {
  const store = use(StoreContext);
  if (!store) throw new Error('useChatStore must be used within StoreContext');
  return store;
}

export function useChatState() {
  const store = useChatStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
