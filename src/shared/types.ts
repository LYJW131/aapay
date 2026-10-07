import type { AuditRecord } from './audit.ts';
import type { Category } from './categories.ts';
import type { Via } from './changes.ts';
import type { Cents } from './money.ts';

// 记账日期由客户端按本地时区决定
export type IsoDate = string;
export type Timestamp = number;

export interface Member {
  id: string;
  name: string;
  avatar: string;
  createdAt: Timestamp;
}

export interface Share {
  memberId: string;
  amount: Cents;
}

export interface Expense {
  id: string;
  title: string;
  amount: Cents;
  payerId: string;
  date: IsoDate;
  category: Category | null;
  shares: Share[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Settlement {
  id: string;
  fromId: string;
  toId: string;
  amount: Cents;
  date: IsoDate;
  note: string | null;
  createdAt: Timestamp;
}

export interface LedgerData {
  version: number;
  members: Member[];
  expenses: Expense[];
  settlements: Settlement[];
}

export interface LedgerInfo {
  id: string;
  name: string;
  emoji: string;
}

export interface Snapshot extends LedgerData {
  ledger: LedgerInfo;
}

export interface LedgerStats {
  members: number;
  expenses: number;
  settlements: number;
  total: Cents;
  lastActivityAt: Timestamp | null;
}

export type LedgerEvent =
  | { type: 'member.saved'; member: Member }
  | { type: 'member.deleted'; id: string }
  | { type: 'expense.saved'; expense: Expense }
  | { type: 'expense.deleted'; id: string }
  | { type: 'settlement.saved'; settlement: Settlement }
  | { type: 'settlement.deleted'; id: string }
  | { type: 'ledger.updated'; ledger: LedgerInfo }
  | { type: 'audit.appended' }
  | { type: 'ledger.closed'; reason: 'deleted' | 'revoked' };

export interface LiveMessage {
  v?: number;
  origin?: string;
  via?: Via;
  batch?: { id: string; size: number };
  event: LedgerEvent;
  at: Timestamp;
  audit?: AuditRecord;
}

export type SessionRole = 'member' | 'admin' | 'shared';

export interface SessionInfo {
  ledger: LedgerInfo;
  role: SessionRole;
  passphrase: string | null;
  subject: string | null;
  expiresAt: Timestamp | null;
}

export type Mode = 'isolated' | 'shared';
export type AdminAuthMode = 'access' | 'password' | 'proxy' | 'none' | 'disabled';

export interface BuildInfo {
  runtime: 'cloudflare' | 'node';
  commit: string;
  message: string;
  builtAt: Timestamp;
}

export interface PublicConfig {
  mode: Mode;
  adminAuth: AdminAuthMode;
  mcp: boolean;
  assistant: { builtin: boolean; model: string } | null;
}

export interface AdminIdentity {
  name: string;
}

export interface SessionState {
  session: SessionInfo | null;
  admin: AdminIdentity | null;
}

export interface LedgerRecord {
  id: string;
  name: string;
  emoji: string;
  createdAt: Timestamp;
  activePassphrases: number;
  connections: number;
}

export interface LedgerOverview extends LedgerRecord {
  stats: LedgerStats | null;
}

export interface Passphrase {
  id: string;
  ledgerId: string;
  code: string;
  validFrom: Timestamp;
  validUntil: Timestamp | null;
  createdAt: Timestamp;
}

export type RegistryEvent =
  | { type: 'ledgers.changed' }
  | { type: 'passphrases.changed'; ledgerId: string }
  | { type: 'connections.changed'; ledgerId: string | null };

export type McpScope = 'ledger:read' | 'ledger:write';

export interface Connection {
  id: string;
  // 客户端自报，未经验证
  clientName: string | null;
  clientHost: string | null;
  subject: string | null;
  scopes: McpScope[];
  createdAt: Timestamp;
  lastUsedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface AuthorizeInfo {
  client: { name: string | null; host: string | null };
  redirectHost: string;
  scopes: McpScope[];
  session: SessionInfo | null;
  adminLoginUrl: string | null;
  denyUrl: string;
}
