import type { Expense, IsoDate, Settlement } from '../../../shared/types.ts';
import { addDays, today } from '../../lib/dates.ts';

export type RangeKey = 'all' | 'today' | '7d' | 'month' | 'custom';

export interface RangeFilter {
  key: RangeKey;
  from?: IsoDate;
  to?: IsoDate;
}

export const RANGE_OPTIONS: { key: Exclude<RangeKey, 'custom'>; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: '7d', label: '近 7 天' },
  { key: 'month', label: '本月' },
];

export function resolveRange(range: RangeFilter): { from: IsoDate | null; to: IsoDate | null } {
  const t = today();
  switch (range.key) {
    case 'today':
      return { from: t, to: t };
    case '7d':
      return { from: addDays(t, -6), to: t };
    case 'month':
      return { from: `${t.slice(0, 8)}01`, to: t };
    case 'custom':
      return { from: range.from ?? null, to: range.to ?? null };
    default:
      return { from: null, to: null };
  }
}

export function inRange(date: IsoDate, { from, to }: { from: IsoDate | null; to: IsoDate | null }) {
  return (!from || date >= from) && (!to || date <= to);
}

export const involves = (record: Expense | Settlement, memberId: string) =>
  'payerId' in record
    ? record.payerId === memberId || record.shares.some((s) => s.memberId === memberId)
    : record.fromId === memberId || record.toId === memberId;

export function rangeLabel(range: RangeFilter) {
  if (range.key !== 'custom') return RANGE_OPTIONS.find((o) => o.key === range.key)!.label;
  const { from, to } = resolveRange(range);
  if (from && from === to) return from;
  return `${from ?? '最早'} ~ ${to ?? '至今'}`;
}
