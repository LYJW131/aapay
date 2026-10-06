import { splitEvenly, type Cents } from './money.ts';
import type { ExpenseInput, ExpenseSplit } from './schema.ts';
import type { Expense, LedgerData, LedgerEvent, Member, Settlement, Share } from './types.ts';

export const byMemberOrder = (a: Member, b: Member) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export const byNewest = (a: Expense | Settlement, b: Expense | Settlement) =>
  b.date.localeCompare(a.date) || b.createdAt - a.createdAt;

function upsert<T extends { id: string }>(list: readonly T[], item: T, order: (a: T, b: T) => number): T[] {
  return [...list.filter((x) => x.id !== item.id), item].sort(order);
}

export function applyEvent(data: LedgerData, event: LedgerEvent, version = data.version): LedgerData {
  switch (event.type) {
    case 'member.saved':
      return { ...data, version, members: upsert(data.members, event.member, byMemberOrder) };
    case 'member.deleted':
      return { ...data, version, members: data.members.filter((m) => m.id !== event.id) };
    case 'expense.saved':
      return { ...data, version, expenses: upsert(data.expenses, event.expense, byNewest) };
    case 'expense.deleted':
      return { ...data, version, expenses: data.expenses.filter((e) => e.id !== event.id) };
    case 'settlement.saved':
      return { ...data, version, settlements: upsert(data.settlements, event.settlement, byNewest) };
    case 'settlement.deleted':
      return { ...data, version, settlements: data.settlements.filter((s) => s.id !== event.id) };
    default:
      return data;
  }
}

export function computeShares(amount: Cents, split: ExpenseSplit, members: readonly Member[]): Share[] {
  const order = new Map([...members].sort(byMemberOrder).map((m, i) => [m.id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  if (split.mode === 'even') return splitEvenly(amount, [...split.memberIds].sort((a, b) => rank(a) - rank(b)));
  return [...split.shares].sort((a, b) => rank(a.memberId) - rank(b.memberId)).map(({ memberId, amount }) => ({ memberId, amount }));
}

export function splitOf(expense: Pick<Expense, 'amount' | 'shares'>, members: readonly Member[]): ExpenseSplit {
  const shares = computeShares(expense.amount, { mode: 'exact', shares: expense.shares }, members);
  const memberIds = shares.map((s) => s.memberId);
  const even = splitEvenly(expense.amount, memberIds);
  return even.every((s, i) => s.amount === shares[i]!.amount) ? { mode: 'even', memberIds } : { mode: 'exact', shares };
}

export function expenseInputOf(expense: Expense, members: readonly Member[]): ExpenseInput {
  return {
    title: expense.title,
    amount: expense.amount,
    payerId: expense.payerId,
    date: expense.date,
    category: expense.category,
    split: splitOf(expense, members),
  };
}

export function sameShares(a: readonly Share[], b: readonly Share[]) {
  const key = (shares: readonly Share[]) => JSON.stringify(shares.map((s) => [s.memberId, s.amount]).sort());
  return key(a) === key(b);
}

export function matchesInput(expense: Expense, input: ExpenseInput, members: readonly Member[]) {
  return (
    expense.title === input.title &&
    expense.amount === input.amount &&
    expense.payerId === input.payerId &&
    expense.date === input.date &&
    expense.category === input.category &&
    sameShares(expense.shares, computeShares(input.amount, input.split, members))
  );
}
