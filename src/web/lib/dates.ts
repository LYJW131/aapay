import type { IsoDate } from '../../shared/types.ts';
import { common } from '../i18n/common.ts';

const pad = (n: number) => String(n).padStart(2, '0');

export function toIsoDate(d: Date): IsoDate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseIsoDate(s: IsoDate): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

export const today = () => toIsoDate(new Date());

export function addDays(s: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(s);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

export function daysBetween(from: IsoDate, to: IsoDate) {
  return Math.round((parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / 86_400_000);
}

export function dayLabel(s: IsoDate): { title: string; sub: string } {
  const d = parseIsoDate(s);
  const t = today();
  const md = common.monthDay(d.getMonth() + 1, d.getDate());
  const weekday = common.weekdays[d.getDay()]!;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (s === t) return { title: common.today, sub: `${md} ${weekday}` };
  if (s === addDays(t, -1)) return { title: common.yesterday, sub: `${md} ${weekday}` };
  return { title: sameYear ? md : common.yearMonthDay(d.getFullYear(), d.getMonth() + 1, d.getDate()), sub: weekday };
}

export function shortDate(s: IsoDate) {
  const d = parseIsoDate(s);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatDateTime(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTime(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return common.justNow;
  if (diff < 3_600_000) return common.minutesAgo(Math.floor(diff / 60_000));
  if (diff < 86_400_000) return common.hoursAgo(Math.floor(diff / 3_600_000));
  if (diff < 30 * 86_400_000) return common.daysAgo(Math.floor(diff / 86_400_000));
  return formatDateTime(ts).slice(0, 10);
}
