import type { Change } from '../../shared/changes.ts';
import type { LedgerData } from '../../shared/types.ts';

type Kind = 'member' | 'expense' | 'settlement';

const kindOf = (change: Change) => change.op.split('.')[0] as Kind;
const targets = (change: Change, kind: Kind, id: string) => kindOf(change) === kind && change.id === id;
const createdIn = (pending: readonly Change[], kind: Kind, id: string) =>
  pending.some((c) => c.op === `${kind}.create` && c.id === id);

// 合并或替换后的改动一律放到末尾：它是按完整草稿校验的，可能引用排在后面才创建的成员
const replaceOrAppend = (pending: readonly Change[], change: Change, replaced: (c: Change) => boolean): Change[] => [
  ...pending.filter((c) => !replaced(c)),
  change,
];

function guarded(change: Change, real: LedgerData): Change {
  if (change.op !== 'expense.update' && change.op !== 'expense.delete') return change;
  const current = real.expenses.find((e) => e.id === change.id);
  return current ? { ...change, ifUpdatedAt: current.updatedAt } : change;
}

export function fold(pending: readonly Change[], change: Change, real: LedgerData): Change[] {
  const kind = kindOf(change);
  switch (change.op) {
    case 'expense.update': {
      const created = pending.find((c): c is Extract<Change, { op: 'expense.create' }> => c.op === 'expense.create' && c.id === change.id);
      if (created) return replaceOrAppend(pending, { ...created, expense: change.expense }, (c) => c === created);
      return replaceOrAppend(pending, guarded(change, real), (c) => c.op === 'expense.update' && c.id === change.id);
    }
    case 'member.update':
      if (createdIn(pending, 'member', change.id)) {
        return pending.map((c) => (c.op === 'member.create' && c.id === change.id ? { ...c, member: change.member } : c));
      }
      return replaceOrAppend(pending, change, (c) => c.op === 'member.update' && c.id === change.id);
    case 'expense.delete':
    case 'member.delete':
    case 'settlement.delete':
      if (createdIn(pending, kind, change.id)) return pending.filter((c) => !targets(c, kind, change.id));
      return replaceOrAppend(pending, guarded(change, real), (c) => targets(c, kind, change.id));
    default:
      return [...pending, change];
  }
}
