import type { ExpenseInput, MemberInput, SettlementInput } from './schema.ts';
import type { LiveMessage } from './types.ts';

export type Via = 'assistant';

export type Change =
  | { op: 'member.create'; id: string; member: MemberInput }
  | { op: 'member.update'; id: string; member: MemberInput }
  | { op: 'member.delete'; id: string }
  | { op: 'expense.create'; id: string; expense: ExpenseInput }
  | { op: 'expense.update'; id: string; expense: ExpenseInput; ifUpdatedAt?: number }
  | { op: 'expense.delete'; id: string; ifUpdatedAt?: number }
  | { op: 'settlement.create'; id: string; settlement: SettlementInput }
  | { op: 'settlement.delete'; id: string };

export interface ChangeResult {
  messages: LiveMessage[];
  undo: Change[];
}
