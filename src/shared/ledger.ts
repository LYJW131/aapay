import type { Expense, LedgerData, LedgerEvent, Member, Settlement } from './types.ts';

export const byMemberOrder = (a: Member, b: Member) => a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** 账目按日期倒序，同一天按创建时间倒序 */
export const byNewest = (a: Expense | Settlement, b: Expense | Settlement) =>
  b.date.localeCompare(a.date) || b.createdAt - a.createdAt;

function upsert<T extends { id: string }>(list: readonly T[], item: T, order: (a: T, b: T) => number): T[] {
  return [...list.filter((x) => x.id !== item.id), item].sort(order);
}

/** 把一条实时事件应用到本地账本数据上（纯函数，前后端共用、便于测试）。 */
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
