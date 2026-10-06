import { CalendarRange, ChartColumnBig, Check, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney } from '../../../shared/money.ts';
import type { Expense, IsoDate } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Card } from '../../components/Card.tsx';
import { CategoryIcon, categoryName } from '../../components/CategoryIcon.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { Hint } from '../../components/Hint.tsx';
import { ledger } from '../../i18n/ledger.ts';
import { cn } from '../../lib/cn.ts';
import { addDays, daysBetween, parseIsoDate, shortDate, today } from '../../lib/dates.ts';
import { useAssistant } from '../assistant/context.ts';
import { useLedger } from './context.tsx';
import type { CategoryFilter } from './filters.ts';
import { inRange, involves, RANGE_OPTIONS, resolveRange, type RangeFilter } from './range.ts';

const t = ledger.overview;

interface Props {
  range: RangeFilter;
  onRange: (range: RangeFilter) => void;
  memberId: string | null;
  onMember: (id: string | null) => void;
  expenses: Expense[];
}

interface Bucket {
  key: string;
  label: string;
  tip: string;
  total: number;
  range: RangeFilter;
}

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
      label: t.month(cur.getMonth() + 1),
      tip: t.yearMonth(y, cur.getMonth() + 1),
      total: totals.get(k) ?? 0,
      range: { key: 'custom', from: `${k}-01`, to: `${k}-${last}` },
    });
  }
  return result;
}

export function OverviewCard({ range, onRange, memberId, onMember, expenses }: Props) {
  const { snapshot, filters, setFilters, memberById } = useLedger();
  const assistant = useAssistant();
  const [customOpen, setCustomOpen] = useState(false);
  const rangeBar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!customOpen) return;
    const close = (e: PointerEvent) => !rangeBar.current?.contains(e.target as Node) && setCustomOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [customOpen]);
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

  const scope = useMemo(
    () => snapshot.expenses.filter((e) => inRange(e.date, resolved) && (!memberId || involves(e, memberId))),
    [snapshot.expenses, resolved.from, resolved.to, memberId],
  );
  const uncategorized = scope.filter((e) => e.category === null).length;
  const tidy = () =>
    assistant.open({
      text: t.tidyPrompt(
        uncategorized,
        range.key === 'all' ? null : ledger.range.span(resolved.from, resolved.to),
        memberId ? (memberById.get(memberId)?.name ?? null) : null,
      ),
      send: true,
    });

  return (
    <Card id="overview" title={t.title} icon={<ChartColumnBig />}>
      <div ref={rangeBar} className="relative">
        <div className="-mx-1 -mt-1 flex gap-1 overflow-x-auto p-1 [scrollbar-width:none]">
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
              setCustomOpen(!customOpen || range.key !== 'custom');
              if (range.key !== 'custom') onRange({ key: 'custom', from: stats.from, to: stats.to });
            }}
          >
            <CalendarRange className="size-3.5" />
            <span className="tabular">
              {range.key === 'custom' && range.from && range.to ? `${shortDate(range.from)} – ${shortDate(range.to)}` : t.custom}
            </span>
          </Chip>
        </div>

        <AnimatePresence>
          {customOpen && range.key === 'custom' && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-x-0 top-full z-20 mt-1 grid grid-cols-2 gap-1.5 rounded-2xl bg-surface p-2 shadow-lg ring-1 ring-zinc-900/8 dark:ring-white/10"
            >
              <input
                type="date"
                value={range.from ?? ''}
                max={range.to}
                onChange={(e) => onRange({ ...range, from: e.target.value || undefined })}
                className="field tabular h-10 min-w-0 px-1 text-center"
                aria-label={t.from}
              />
              <input
                type="date"
                value={range.to ?? ''}
                min={range.from}
                onChange={(e) => onRange({ ...range, to: e.target.value || undefined })}
                className="field tabular h-10 min-w-0 px-1 text-center"
                aria-label={t.to}
              />
              <button
                type="button"
                onClick={() => setCustomOpen(false)}
                className="col-span-2 flex h-9 items-center justify-center gap-1 rounded-xl text-sm font-medium text-brand-600 transition hover:bg-brand-500/10 dark:text-brand-300"
              >
                <Check className="size-4" />
                {t.done}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Collapse open={snapshot.members.length > 1} className="pt-2">
        <div className="-mx-1 -mt-1 flex gap-1 overflow-x-auto p-1 [scrollbar-width:none]">
          <Chip active={!memberId} onClick={() => onMember(null)}>
            {t.allMembers}
          </Chip>
          {snapshot.members.map((m) => (
            <Chip key={m.id} active={memberId === m.id} onClick={() => onMember(memberId === m.id ? null : m.id)}>
              <Avatar member={m} size="xs" className="-ml-1.5 bg-transparent! text-sm" />
              {m.name}
            </Chip>
          ))}
        </div>
      </Collapse>

      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">
            {t.total(!!memberId, expenses.length)}
          </p>
          <p className="mt-1 text-[40px] leading-none font-semibold tracking-tight">{formatMoney(stats.total)}</p>
        </div>
        <dl className="flex gap-6 text-sm">
          {memberId ? (
            <>
              <Stat label={t.paid} value={formatMoney(stats.paid)} />
              <Stat label={t.share} value={formatMoney(stats.consumed)} />
            </>
          ) : (
            <>
              <Stat label={t.dailyAverage} value={formatMoney(Math.round(stats.total / stats.days))} />
              <Stat label={t.days} value={t.dayCount(stats.days)} />
            </>
          )}
        </dl>
      </div>

      <SpendChart
        series={stats.series}
        empty={stats.total === 0 ? t.noSpending : t.tooShort}
        onPick={(b) => (setCustomOpen(false), onRange(b.range))}
      />

      <Collapse open={scope.length > 0} className="pt-5">
        <CategoryBreakdown
          expenses={scope}
          selected={filters.category}
          onSelect={(category) => setFilters({ category: filters.category === category ? null : category })}
        />
        <Collapse open={assistant.available && uncategorized > 0} className="pt-2">
          <button
            type="button"
            onClick={tidy}
            className="-ml-1 flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-brand-600 transition hover:bg-brand-500/10 dark:text-brand-300"
          >
            <Sparkles className="size-3.5" />
            {t.tidy(uncategorized)}
          </button>
        </Collapse>
      </Collapse>
    </Card>
  );
}

type CategoryKey = Exclude<CategoryFilter, null>;

export function CategoryBreakdown({
  expenses,
  selected,
  onSelect,
}: {
  expenses: readonly Expense[];
  selected: CategoryFilter;
  onSelect: (category: CategoryKey) => void;
}) {
  const { rows, total } = useMemo(() => {
    const sums = new Map<CategoryKey, number>();
    for (const e of expenses) {
      const k = e.category ?? 'none';
      sums.set(k, (sums.get(k) ?? 0) + e.amount);
    }
    if (selected && !sums.has(selected)) sums.set(selected, 0);
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    return { rows: [...sums].sort((a, b) => b[1] - a[1]), total };
  }, [expenses, selected]);

  return (
    <section>
      <h3 className="mb-1.5 flex h-5 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
        {t.categories}
        <Hint>{t.categoriesHint}</Hint>
      </h3>
      <ul className="-mx-2">
        {rows.map(([key, amount]) => {
          const active = selected === key;
          const ratio = total > 0 ? amount / total : 0;
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(key)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition',
                  active ? 'bg-brand-500/8 ring-1 ring-brand-500/30 dark:bg-brand-400/10' : 'hover:bg-zinc-900/3 dark:hover:bg-white/4',
                  selected && !active && 'opacity-55',
                )}
              >
                <CategoryIcon category={key === 'none' ? null : key} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-medium">
                      {key === 'none' ? t.uncategorized : categoryName(key)}
                      <span className="tabular ml-1.5 text-xs font-normal text-zinc-400">{percent(ratio)}</span>
                    </span>
                    <span className="tabular shrink-0 font-semibold">{formatMoney(amount)}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/6">
                    <div
                      className={cn('h-full rounded-full transition-[width] duration-500', key === 'none' ? 'bg-zinc-300 dark:bg-zinc-600' : 'bg-chart')}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function percent(ratio: number) {
  if (ratio > 0 && ratio < 0.01) return '<1%';
  return `${Math.round(ratio * 100)}%`;
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

function SpendChart({ series, empty, onPick }: { series: Bucket[]; empty: string; onPick: (b: Bucket) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...series.map((b) => b.total));
  const active = hover === null ? null : series[hover];
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter((v, i, a) => v >= 0 && a.indexOf(v) === i);

  if (max === 0) {
    return (
      <figure className="mt-5">
        <figcaption className="mb-2 flex h-5 items-center text-xs text-zinc-500 dark:text-zinc-400">{t.trend}</figcaption>
        <div className="flex h-28 items-center justify-center rounded-2xl bg-zinc-50 text-[13px] text-zinc-400 dark:bg-white/3">{empty}</div>
        <div className="mt-1.5 h-4" />
      </figure>
    );
  }

  return (
    <figure className="mt-5">
      <figcaption className="mb-2 flex h-5 items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
        <span>{series[0]!.key.length === 7 ? t.monthly : t.daily}</span>
        <span className="tabular">
          {active ? (
            <>
              {active.tip} · <b className="font-semibold text-zinc-900 dark:text-zinc-100">{formatMoney(active.total)}</b>
            </>
          ) : (
            <>{t.peak(formatMoney(max))}</>
          )}
        </span>
      </figcaption>
      <div
        key={`${series[0]!.key}-${series.length}`}
        className="animate-fade-in relative flex h-28 items-end border-b border-zinc-200 dark:border-white/10"
        onMouseLeave={() => setHover(null)}
      >
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
