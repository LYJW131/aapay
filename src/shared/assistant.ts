import type { Category } from './categories.ts';
import type { Change } from './changes.ts';
import type { IsoDate } from './types.ts';

export interface AssistantTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AssistantRequest {
  messages: AssistantTurn[];
  images: string[];
  pending: Change[];
  me: string | null;
  participants: string[] | null;
  today: IsoDate;
}

export interface DraftFields {
  title?: string;
  amount?: number;
  date?: IsoDate | null;
  category?: Category;
}

export interface ViewRange {
  from: IsoDate | null;
  to: IsoDate | null;
}

export type AssistantView =
  | { kind: 'balances' }
  | { kind: 'settle' }
  | ({ kind: 'categories'; memberId: string | null } & ViewRange)
  | ({ kind: 'trend'; memberId: string | null; category: Category | null } & ViewRange)
  | ({ kind: 'transactions'; memberId: string | null; category: Category | null; query: string | null } & ViewRange);

export interface DroppedChange {
  id: string;
  reason: string;
}

export type AssistantEvent =
  | { type: 'step'; id: string; tool: string; status: 'start' | 'done' | 'error' }
  | { type: 'text'; delta: string }
  | { type: 'draft'; key: string; fields: DraftFields }
  | { type: 'discard'; key: string }
  | { type: 'pending'; changes: Change[]; replaces?: string; dropped?: DroppedChange[] }
  | { type: 'view'; view: AssistantView }
  | { type: 'done' }
  | { type: 'error'; message: string };
