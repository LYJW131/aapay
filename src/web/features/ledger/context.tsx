import { createContext, use } from 'react';
import type { Member, SessionInfo, Snapshot } from '../../../shared/types.ts';
import type { ActivityLog } from './activity.ts';
import type { LedgerStore } from './store.ts';

export interface LedgerContextValue {
  snapshot: Snapshot;
  session: SessionInfo;
  store: LedgerStore;
  activity: ActivityLog;
  memberById: Map<string, Member>;
  key: (name: string) => string;
}

export const LedgerContext = createContext<LedgerContextValue | null>(null);

export function useLedger() {
  const value = use(LedgerContext);
  if (!value) throw new Error('useLedger 必须在 LedgerContext 内使用');
  return value;
}
