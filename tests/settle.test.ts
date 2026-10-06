import { describe, expect, it } from 'vitest';
import { splitEvenly } from '../src/shared/money.ts';
import { computeBalances, suggestTransfers } from '../src/shared/settle.ts';
import type { Expense, Member, Settlement } from '../src/shared/types.ts';

const member = (id: string): Member => ({ id, name: id, avatar: '🐱', createdAt: 0 });
const expense = (payerId: string, amount: number, ids: string[]): Expense => ({
  id: Math.random().toString(36),
  title: 't',
  amount,
  payerId,
  date: '2026-10-01',
  category: null,
  shares: splitEvenly(amount, ids),
  createdAt: 0,
  updatedAt: 0,
});
const settlement = (fromId: string, toId: string, amount: number): Settlement => ({
  id: Math.random().toString(36),
  fromId,
  toId,
  amount,
  date: '2026-10-02',
  note: null,
  createdAt: 0,
});

describe('settlement', () => {
  const members = ['a', 'b', 'c'].map(member);

  it('computes net balances', () => {
    const balances = computeBalances(members, [expense('a', 3000, ['a', 'b', 'c'])], []);
    expect(Object.fromEntries(balances.map((b) => [b.memberId, b.net]))).toEqual({ a: 2000, b: -1000, c: -1000 });
    expect(balances.reduce((t, b) => t + b.net, 0)).toBe(0);
  });

  it('suggests the minimal set of transfers', () => {
    const expenses = [expense('a', 3000, ['a', 'b', 'c']), expense('b', 900, ['a', 'b', 'c'])];
    const transfers = suggestTransfers(computeBalances(members, expenses, []));
    expect(transfers).toEqual([
      { fromId: 'c', toId: 'a', amount: 1300 },
      { fromId: 'b', toId: 'a', amount: 400 },
    ]);
  });

  it('accounts for recorded settlements', () => {
    const expenses = [expense('a', 3000, ['a', 'b', 'c'])];
    const settlements = [settlement('b', 'a', 1000)];
    const balances = computeBalances(members, expenses, settlements);
    expect(balances.find((b) => b.memberId === 'b')!.net).toBe(0);
    expect(suggestTransfers(balances)).toEqual([{ fromId: 'c', toId: 'a', amount: 1000 }]);
  });

  it('returns nothing when everyone is settled', () => {
    const expenses = [expense('a', 1000, ['a', 'b'])];
    expect(suggestTransfers(computeBalances(members, expenses, [settlement('b', 'a', 500)]))).toEqual([]);
  });
});
