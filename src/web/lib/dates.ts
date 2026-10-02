import type { IsoDate } from '../../shared/types.ts';

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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function dayLabel(s: IsoDate): { title: string; sub: string } {
  const d = parseIsoDate(s);
  const t = today();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const weekday = WEEKDAYS[d.getDay()]!;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (s === t) return { title: '今天', sub: `${md} ${weekday}` };
  if (s === addDays(t, -1)) return { title: '昨天', sub: `${md} ${weekday}` };
  return { title: sameYear ? md : `${d.getFullYear()}年${md}`, sub: weekday };
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
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(ts).slice(0, 10);
}
