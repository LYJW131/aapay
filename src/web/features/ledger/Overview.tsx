import { CalendarRange, ChartColumnBig } from 'lucide-react';
import { useMemo, useState } from 'react';
import { formatMoney } from '../../../shared/money.ts';
import type { Expense, IsoDate } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Card } from '../../components/Card.tsx';
import { cn } from '../../lib/cn.ts';
import { addDays, daysBetween, parseIsoDate, shortDate, today } from '../../lib/dates.ts';
import { useLedger } from './context.tsx';
import { RANGE_OPTIONS, resolveRange, type RangeFilter } from './range.ts';

interface Props {
  range: RangeFilter;
  onRange: (range: RangeFilter) => void;
  memberId: string | null;
  onMember: (id: string | null) => void;
  /** 已按时间与成员筛选后的支出 */
  expenses: Expense[];
}

interface Bucket {
  key: string;
  label: string;
  tip: string;
  total: number;
  range: RangeFilter;
}

/** 把支出按天（跨度 ≤ 62 天）或按月聚合成柱状图数据 */
function buckets(expenses: Expense[], from: IsoDate, to: IsoDate): Bucket[] {
  const totals = new Map<string, number>();
  const span = daysBetween(from, to) + 1;
  const monthly = span > 62;
  for (const e of expenses) {
    const k = monthly ? e.date.slice(0, 7) : e.date;
    totals.set(k, (totals.get(k) ?? 0) + e.amount);
  }
  const result: Bucket[] = [];
  if (!monthly) {
    for (let d = from; d <= to; d = addDays(d, 1)) {
      result.push({
        key: d,
        label: shortDate(d),
        tip: d,
        total: totals.get(d) ?? 0,
        range: { key: 'custom', from: d, to: d },
      });
    }
    return result;
  }
  const end = parseIsoDate(to);
  for (const cur = parseIsoDate(`${from.slice(0, 7)}-01`); cur <= end; cur.setMonth(cur.getMonth() + 1)) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const k = `${y}-${m}`;
    const last = new Date(y, cur.getMonth() + 1, 0).getDate();
    result.push({
      key: k,
      label: `${cur.getMonth() + 1}月`,
      tip: `${y}年${cur.getMonth() + 1}月`,
      total: totals.get(k) ?? 0,
      range: { key: 'custom', from: `${k}-01`, to: `${k}-${last}` },
    });
  }
  return result;
}

export function OverviewCard({ range, onRange, memberId, onMember, expenses }: Props) {
  const { snapshot } = useLedger();
  const [customOpen, setCustomOpen] = useState(range.key === 'custom');
  const resolved = resolveRange(range);

  const stats = useMemo(() => {
    const total = expenses.reduce((t, e) => t + e.amount, 0);
    const oldest = expenses.at(-1)?.date;
    const newest = expenses[0]?.date;
    const from = resolved.from ?? oldest ?? today();
    const to = resolved.to ?? (newest && newest > today() ? newest : today());
    const days = Math.max(1, daysBetween(from, to) + 1);
    const paid = memberId ? expenses.filter((e) => e.payerId === memberId).reduce((t, e) => t + e.amount, 0) : 0;
    const consumed = memberId
      ? expenses.reduce((t, e) => t + (e.shares.find((s) => s.memberId === memberId)?.amount ?? 0), 0)
      : 0;
    return { total, from, to, days, paid, consumed, series: days >= 3 ? buckets(expenses, from, to) : [] };
  }, [expenses, resolved.from, resolved.to, memberId]);

  return (
    <Card title="账本概览" icon={<ChartColumnBig />}>
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        {RANGE_OPTIONS.map((o) => (
          <Chip
            key={o.key}
            active={range.key === o.key}
            onClick={() => {
              setCustomOpen(false);
              onRange({ key: o.key });
            }}
          >
            {o.label}
          </Chip>
        ))}
        <Chip
          active={range.key === 'custom'}
          onClick={() => {
            setCustomOpen(true);
            if (range.key !== 'custom') onRange({ key: 'custom', from: stats.from, to: stats.to });
          }}
        >
          <CalendarRange className="size-3.5" />
          自定义
        </Chip>
      </div>

      {customOpen && range.key === 'custom' && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="date"
            value={range.from ?? ''}
            max={range.to}
            onChange={(e) => onRange({ ...range, from: e.target.value || undefined })}
            className="field tabular h-10 min-w-0 flex-1 px-3 text-center text-sm"
            aria-label="开始日期"
          />
          <span className="text-zinc-400">~</span>
          <input
            type="date"
            value={range.to ?? ''}
            min={range.from}
            onChange={(e) => onRange({ ...range, to: e.target.value || undefined })}
            className="field tabular h-10 min-w-0 flex-1 px-3 text-center text-sm"
            aria-label="结束日期"
          />
        </div>
      )}

      {snapshot.members.length > 1 && (
        <div className="mt-2 -mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <Chip active={!memberId} onClick={() => onMember(null)}>
            全部成员
          </Chip>
          {snapshot.members.map((m) => (
            <Chip key={m.id} active={memberId === m.id} onClick={() => onMember(memberId === m.id ? null : m.id)}>
              <Avatar member={m} size="xs" className="-ml-1.5 bg-transparent! text-sm" />
              {m.name}
            </Chip>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
            {memberId ? '相关支出' : '总支出'} · {expenses.length} 笔
          </p>
          <p className="mt-1 text-[40px] leading-none font-semibold tracking-tight">{formatMoney(stats.total)}</p>
        </div>
        <dl className="flex gap-6 text-sm">
          {memberId ? (
            <>
              <Stat label="TA 垫付" value={formatMoney(stats.paid)} />
              <Stat label="TA 分摊" value={formatMoney(stats.consumed)} />
            </>
          ) : (
            <>
              <Stat label="日均" value={formatMoney(Math.round(stats.total / stats.days))} />
              <Stat label="天数" value={`${stats.days} 天`} />
            </>
          )}
        </dl>
      </div>

      {stats.series.length > 0 && stats.total > 0 && (
        <SpendChart series={stats.series} onPick={(b) => (setCustomOpen(true), onRange(b.range))} />
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="tabular mt-0.5 font-semibold">{value}</dd>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1 rounded-full px-3 text-[13px] font-medium whitespace-nowrap transition',
        active
          ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
          : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200/80 dark:bg-white/6 dark:text-zinc-300 dark:hover:bg-white/10',
      )}
    >
      {children}
    </button>
  );
}

/** 单系列柱状图：每日（或每月）支出。悬停显示数值，点击下钻到该时间段。 */
function SpendChart({ series, onPick }: { series: Bucket[]; onPick: (b: Bucket) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...series.map((b) => b.total));
  const active = hover === null ? null : series[hover]!;
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <figure className="mt-5">
      <figcaption className="mb-2 flex h-5 items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{series[0]!.key.length === 7 ? '每月支出' : '每日支出'}</span>
        <span className="tabular">
          {active ? (
            <>
              {active.tip} · <b className="font-semibold text-zinc-900 dark:text-zinc-100">{formatMoney(active.total)}</b>
            </>
          ) : (
            <>峰值 {formatMoney(max)}</>
          )}
        </span>
      </figcaption>
      <div className="relative flex h-28 items-end border-b border-zinc-200 dark:border-white/10" onMouseLeave={() => setHover(null)}>
        {series.map((b, i) => (
          <button
            key={b.key}
            type="button"
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            onClick={() => b.total > 0 && onPick(b)}
            aria-label={`${b.tip} ${formatMoney(b.total)}`}
            className="group flex h-full min-w-0 flex-1 items-end justify-center px-px"
          >
            <span
              className={cn(
                'block w-full max-w-6 rounded-t-[4px] bg-chart transition-[opacity,height] duration-300',
                hover !== null && hover !== i && 'opacity-35',
              )}
              style={{ height: b.total ? `${Math.max(3, (b.total / max) * 100)}%` : 0 }}
            />
          </button>
        ))}
      </div>
      <div className="relative mt-1.5 h-4 text-[11px] text-zinc-400">
        {ticks.map((i) => (
          <span
            key={i}
            className="tabular absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
            style={{ left: `${(i / Math.max(1, series.length - 1)) * 100}%` }}
          >
            {series[i]!.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
