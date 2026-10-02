import type { Cents } from './money.ts';

/** YYYY-MM-DD（记账日期，由客户端按本地时区决定） */
export type IsoDate = string;
/** Unix 毫秒时间戳 */
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
  shares: Share[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** 一笔还款：from 向 to 支付了 amount */
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
  | { type: 'ledger.renamed'; name: string }
  | { type: 'ledger.closed'; reason: 'deleted' | 'revoked' };

/** 通过 WebSocket 推送给账本内所有在线客户端的消息 */
export interface LiveMessage {
  /** 数据版本号；账目变更时递增，客户端据此判断是否漏掉消息 */
  v?: number;
  /** 发起变更的客户端 ID，用于避免给自己弹通知；来自 MCP 时形如 mcp:Claude */
  origin?: string;
  event: LedgerEvent;
  at: Timestamp;
}

export type SessionRole = 'member' | 'admin' | 'shared';

export interface SessionInfo {
  ledger: LedgerInfo;
  role: SessionRole;
  /** 成员通过口令加入时返回该口令，便于继续分享 */
  passphrase: string | null;
  expiresAt: Timestamp | null;
}

export type Mode = 'isolated' | 'shared';
export type AdminAuthMode = 'access' | 'password' | 'proxy' | 'none' | 'disabled';

export interface PublicConfig {
  mode: Mode;
  adminAuth: AdminAuthMode;
  /** 是否开放 /mcp 端点供 Claude、ChatGPT 等 AI 应用连接 */
  mcp: boolean;
}

export interface AdminIdentity {
  name: string;
  method: AdminAuthMode;
}

export interface LedgerRecord {
  id: string;
  name: string;
  createdAt: Timestamp;
  activePassphrases: number;
  /** 已连接的 AI 应用数 */
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
  | { type: 'connections.changed'; ledgerId: string };

export type McpScope = 'ledger:read' | 'ledger:write';

/** 通过 OAuth 连接到某个账本的 AI 应用（一次授权） */
export interface Connection {
  id: string;
  /** 客户端自报的名称（如 Claude），未经验证 */
  clientName: string | null;
  /** 客户端主页或回调地址的主机名，用于辨认来源 */
  clientHost: string | null;
  scopes: McpScope[];
  createdAt: Timestamp;
  lastUsedAt: Timestamp;
  expiresAt: Timestamp;
}

/** OAuth 授权页需要展示的信息 */
export interface AuthorizeInfo {
  client: { name: string | null; host: string | null };
  /** 授权完成后跳回的主机 */
  redirectHost: string;
  scopes: McpScope[];
  /** 当前浏览器已登录的账本，可直接授权 */
  session: SessionInfo | null;
  /** 用户拒绝时跳转的地址 */
  denyUrl: string;
}
