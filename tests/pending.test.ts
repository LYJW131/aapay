import { describe, expect, it } from 'vitest';
import { fold } from '../src/server/ai/pending.ts';
import type { Change } from '../src/shared/changes.ts';
import type { ExpenseInput } from '../src/shared/schema.ts';
import type { LedgerData } from '../src/shared/types.ts';

const input = (title: string, amount = 1000): ExpenseInput => ({
  title,
  amount,
  payerId: 'memberAAAA',
  date: '2026-10-06',
  category: null,
  split: { mode: 'even', memberIds: ['memberAAAA'] },
});

const real: LedgerData = {
  version: 3,
  members: [{ id: 'memberAAAA', name: 'A', avatar: '🐱', createdAt: 1 }],
  expenses: [{ id: 'expenseOLD', ...input('old'), shares: [{ memberId: 'memberAAAA', amount: 1000 }], createdAt: 5, updatedAt: 42 }],
  settlements: [{ id: 'settleOLD1', fromId: 'memberAAAA', toId: 'memberBBBB', amount: 100, date: '2026-10-01', note: null, createdAt: 7 }],
};

const create: Change = { op: 'expense.create', id: 'expenseNEW', expense: input('new') };
const settle: Change = { op: 'settlement.create', id: 'settleNEW1', settlement: { fromId: 'memberAAAA', toId: 'memberBBBB', amount: 100, date: '2026-10-06' } };

describe('fold', () => {
  it('appends new records', () => {
    expect(fold([create], settle, real)).toEqual([create, settle]);
  });

  it('merges updates of pending records into their create', () => {
    const pending = fold([create, settle], { op: 'expense.update', id: 'expenseNEW', expense: input('renamed', 2000), ifUpdatedAt: 99 }, real);
    expect(pending).toEqual([{ ...create, expense: input('renamed', 2000) }, settle]);

    const member: Change = { op: 'member.create', id: 'memberNEW1', member: { name: 'B', avatar: '🐶' } };
    expect(fold([member], { op: 'member.update', id: 'memberNEW1', member: { name: 'C', avatar: '🐶' } }, real)).toEqual([
      { ...member, member: { name: 'C', avatar: '🐶' } },
    ]);
  });

  it('removes a pending record that gets deleted', () => {
    expect(fold([create, settle], { op: 'expense.delete', id: 'expenseNEW', ifUpdatedAt: 99 }, real)).toEqual([settle]);
    expect(fold([create, settle], { op: 'settlement.delete', id: 'settleNEW1' }, real)).toEqual([create]);
  });

  it('replaces repeated updates of an existing record and guards them with the real updatedAt', () => {
    const first = fold([create], { op: 'expense.update', id: 'expenseOLD', expense: input('first'), ifUpdatedAt: 77 }, real);
    expect(first).toEqual([create, { op: 'expense.update', id: 'expenseOLD', expense: input('first'), ifUpdatedAt: 42 }]);
    const second = fold([...first, settle], { op: 'expense.update', id: 'expenseOLD', expense: input('second'), ifUpdatedAt: 78 }, real);
    expect(second).toEqual([create, { op: 'expense.update', id: 'expenseOLD', expense: input('second'), ifUpdatedAt: 42 }, settle]);

    const member = fold([{ op: 'member.update', id: 'memberAAAA', member: { name: 'X' } }], { op: 'member.update', id: 'memberAAAA', member: { name: 'Y' } }, real);
    expect(member).toEqual([{ op: 'member.update', id: 'memberAAAA', member: { name: 'Y' } }]);
  });

  it('turns update then delete of an existing record into a delete', () => {
    const updated = fold([], { op: 'expense.update', id: 'expenseOLD', expense: input('first'), ifUpdatedAt: 77 }, real);
    expect(fold([...updated, create], { op: 'expense.delete', id: 'expenseOLD', ifUpdatedAt: 78 }, real)).toEqual([
      { op: 'expense.delete', id: 'expenseOLD', ifUpdatedAt: 42 },
      create,
    ]);
    expect(fold([], { op: 'settlement.delete', id: 'settleOLD1' }, real)).toEqual([{ op: 'settlement.delete', id: 'settleOLD1' }]);
  });
});
