import { categoryLabel } from '../../../shared/audit-text.ts';
import type { Category } from '../../../shared/categories.ts';
import type { Change } from '../../../shared/changes.ts';
import { computeShares, sameShares, splitOf } from '../../../shared/ledger.ts';
import { formatMoney } from '../../../shared/money.ts';
import type { ExpenseInput } from '../../../shared/schema.ts';
import type { Expense, IsoDate, Member, Snapshot } from '../../../shared/types.ts';
import { assistant as t } from '../../i18n/assistant.ts';
import { locale } from '../../i18n/locale.ts';
import { dayLabel, daysBetween } from '../../lib/dates.ts';

export const categoryText = (category: Category | null) => categoryLabel(category, locale);

export const dateText = (date: IsoDate) => dayLabel(date).title;

export function membersWithPending(snapshot: Snapshot, changes: readonly Change[]): Member[] {
  const members = new Map(snapshot.members.map((m) => [m.id, m]));
  for (const c of changes) {
    if (c.op === 'member.create' || c.op === 'member.update') {
      members.set(c.id, { id: c.id, name: c.member.name, avatar: c.member.avatar ?? '', createdAt: members.get(c.id)?.createdAt ?? Number.MAX_SAFE_INTEGER });
    }
  }
  return [...members.values()];
}

export function splitSummary(input: Pick<ExpenseInput, 'amount' | 'split'>) {
  if (input.split.mode === 'even') {
    const n = input.split.memberIds.length;
    return t.splitEven(n, formatMoney(Math.floor(input.amount / Math.max(1, n))));
  }
  return t.splitCustom(input.split.shares.length);
}

const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');

function similar(a: string, b: string) {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const grams = (s: string) => new Set(Array.from({ length: Math.max(1, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const gx = grams(x);
  const gy = grams(y);
  const common = [...gx].filter((g) => gy.has(g)).length;
  return (2 * common) / (gx.size + gy.size) >= 0.5;
}

export function findDuplicate(input: ExpenseInput, expenses: readonly Expense[]) {
  return expenses.find((e) => e.amount === input.amount && Math.abs(daysBetween(e.date, input.date)) <= 1 && similar(e.title, input.title)) ?? null;
}

export interface FieldDiff {
  label: string;
  before: string;
  after: string;
}

export function expenseDiff(before: Expense, after: ExpenseInput, members: readonly Member[], name: (id: string) => string): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const f = t.fields;
  if (before.title !== after.title) diffs.push({ label: f.title, before: before.title, after: after.title });
  if (before.amount !== after.amount) diffs.push({ label: f.amount, before: formatMoney(before.amount), after: formatMoney(after.amount) });
  if (before.payerId !== after.payerId) diffs.push({ label: f.payer, before: name(before.payerId), after: name(after.payerId) });
  if (before.date !== after.date) diffs.push({ label: f.date, before: dateText(before.date), after: dateText(after.date) });
  if (before.category !== after.category) diffs.push({ label: f.category, before: categoryText(before.category), after: categoryText(after.category) });
  const shares = computeShares(after.amount, after.split, members);
  if (!sameShares(before.shares, shares)) {
    const people = (ids: string[]) => ids.map(name).join(locale === 'zh-CN' ? '、' : ', ');
    const was = before.shares.map((s) => s.memberId);
    const now = shares.map((s) => s.memberId);
    const samePeople = was.length === now.length && was.every((id) => now.includes(id));
    diffs.push(
      samePeople
        ? { label: f.split, before: splitSummary({ ...after, amount: before.amount, split: splitOf(before, members) }), after: splitSummary(after) }
        : { label: f.split, before: people(was), after: people(now) },
    );
  }
  return diffs;
}

export function changeTotal(changes: readonly Change[]) {
  return changes.reduce((sum, c) => sum + (c.op === 'expense.create' ? c.expense.amount : 0), 0);
}
