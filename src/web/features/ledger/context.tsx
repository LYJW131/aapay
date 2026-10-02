import { createContext, use } from 'react';
import type { Member, SessionInfo, Snapshot } from '../../../shared/types.ts';
import type { LedgerStore } from './store.ts';

export interface LedgerContextValue {
  snapshot: Snapshot;
  session: SessionInfo;
  store: LedgerStore;
  memberById: Map<string, Member>;
  /** 按账本隔离的本地存储 key */
  key: (name: string) => string;
}

export const LedgerContext = createContext<LedgerContextValue | null>(null);

export function useLedger() {
  const value = use(LedgerContext);
  if (!value) throw new Error('useLedger 必须在 LedgerContext 内使用');
  return value;
}
