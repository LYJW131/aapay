import type { Cents } from './money.ts';
import type { Expense, Member, Settlement } from './types.ts';

export interface Balance {
  memberId: string;
  paid: Cents;
  consumed: Cents;
  sent: Cents;
  received: Cents;
  // > 0 表示别人还欠 TA，< 0 表示 TA 还欠别人
  net: Cents;
}

export interface Transfer {
  fromId: string;
  toId: string;
  amount: Cents;
}

export function computeBalances(
  members: readonly Member[],
  expenses: readonly Expense[],
  settlements: readonly Settlement[],
): Balance[] {
  const map = new Map<string, Balance>();
  const get = (memberId: string) => {
    let b = map.get(memberId);
    if (!b) map.set(memberId, (b = { memberId, paid: 0, consumed: 0, sent: 0, received: 0, net: 0 }));
    return b;
  };
  for (const m of members) get(m.id);
  for (const e of expenses) {
    get(e.payerId).paid += e.amount;
    for (const s of e.shares) get(s.memberId).consumed += s.amount;
  }
  for (const s of settlements) {
    get(s.fromId).sent += s.amount;
    get(s.toId).received += s.amount;
  }
  for (const b of map.values()) b.net = b.paid - b.consumed + b.sent - b.received;
  return [...map.values()];
}

// 贪心：每次让欠得最多的人还给被欠得最多的人，n 个有余额的人最多 n - 1 笔
export function suggestTransfers(balances: readonly Balance[]): Transfer[] {
  const debtors = balances.filter((b) => b.net < 0).map((b) => ({ id: b.memberId, left: -b.net }));
  const creditors = balances.filter((b) => b.net > 0).map((b) => ({ id: b.memberId, left: b.net }));
  const byLeft = (a: { left: number; id: string }, b: { left: number; id: string }) =>
    b.left - a.left || a.id.localeCompare(b.id);
  debtors.sort(byLeft);
  creditors.sort(byLeft);

  const transfers: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const amount = Math.min(d.left, c.left);
    transfers.push({ fromId: d.id, toId: c.id, amount });
    d.left -= amount;
    c.left -= amount;
    if (d.left === 0) i++;
    if (c.left === 0) j++;
  }
  return transfers;
}
