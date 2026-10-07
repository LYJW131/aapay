import { ArrowRight, ChartColumnBig, ChartPie, Check, ChevronRight, HandCoins, ListFilter, PartyPopper, Scale } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { AssistantView, ViewRange } from '../../../shared/assistant.ts';
import type { Category } from '../../../shared/categories.ts';
import { newId } from '../../../shared/ids.ts';
import { byNewest } from '../../../shared/ledger.ts';
import { formatMoney } from '../../../shared/money.ts';
import { computeBalances, suggestTransfers, type Transfer } from '../../../shared/settle.ts';
import type { Expense, IsoDate } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { CategoryIcon, categoryName } from '../../components/CategoryIcon.tsx';
import { assistant as t } from '../../i18n/assistant.ts';
import { ledger } from '../../i18n/ledger.ts';
import { errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { addDays, daysBetween, parseIsoDate, shortDate, today } from '../../lib/dates.ts';
import { useLedger } from '../ledger/context.tsx';
import { involves, inRange } from '../ledger/range.ts';
import { undoAction } from '../ledger/undo.ts';
import { categoryText, dateText } from './describe.ts';

const v = t.views;

function Frame({ icon, title, aside, children }: { icon: ReactNode; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="animate-fade-in rounded-3xl bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-16px_rgb(0_0_0/0.18)] ring-1 ring-zinc-900/6 dark:bg-white/4 dark:shadow-none dark:ring-white/10">
      <header className="mb-3 flex items-center gap-2">
        <span className="text-brand-500 dark:text-brand-300 [&>svg]:size-4">{icon}</span>
        <h3 className="flex-1 truncate text-[13px] font-semibold">{title}</h3>
        {aside && <span className="shrink-0 text-xs text-zinc-400">{aside}</span>}
      </header>
      {children}
    </section>
  );
}

const shareOf = (e: Expense, memberId: string | null) => (memberId ? (e.shares.find((s) => s.memberId === memberId)?.amount ?? 0) : e.amount);

function useScoped(range: ViewRange, memberId: string | null, category: Category | null) {
  const { snapshot } = useLedger();
  return useMemo(
    () =>
      snapshot.expenses.filter(
        (e) => inRange(e.date, range) && (!memberId || involves(e, memberId)) && (!category || e.category === category),
      ),
    [snapshot.expenses, range.from, range.to, memberId, category],
  );
}

function rangeText({ from, to }: ViewRange) {
  if (!from && !to) return ledger.range.all;
  if (from && from === to) return dateText(from);
  return `${from ? shortDate(from) : '…'} – ${to ? shortDate(to) : '…'}`;
}

export function ViewCard({ view, onNavigate }: { view: AssistantView; onNavigate: () => void }) {
  switch (view.kind) {
    case 'balances':
      return <Balances />;
    case 'settle':
      return <Settle />;
    case 'categories':
      return <Categories range={view} memberId={view.memberId} />;
    case 'trend':
      return <Trend range={view} memberId={view.memberId} category={view.category} />;
    case 'transactions':
      return <Transactions view={view} onNavigate={onNavigate} />;
  }
}

function useBalances() {
  const { snapshot, memberById } = useLedger();
  return useMemo(() => {
    const balances = computeBalances(snapshot.members, snapshot.expenses, snapshot.settlements).filter((b) => memberById.has(b.memberId));
    return {
      balances: balances.sort((a, b) => b.net - a.net),
      transfers: suggestTransfers(balances).sort((a, b) => b.amount - a.amount),
      maxAbs: Math.max(1, ...balances.map((b) => Math.abs(b.net))),
    };
  }, [snapshot, memberById]);
}

function Balances() {
  const { memberById } = useLedger();
  const { balances, maxAbs } = useBalances();
  return (
    <Frame icon={<Scale />} title={v.balances}>
      <ul className="space-y-2.5">
        {balances.map((b) => {
          const pct = (Math.abs(b.net) / maxAbs) * 50;
          return (
            <li key={b.memberId} className="grid grid-cols-[minmax(0,5.5rem)_1fr_auto] items-center gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <Avatar member={memberById.get(b.memberId)} size="xs" />
                <span className="truncate text-sm">{memberById.get(b.memberId)?.name}</span>
              </span>
              <span className="relative h-2 rounded-full bg-zinc-100 dark:bg-white/6" aria-hidden>
                <span className="absolute inset-y-0 left-1/2 w-px bg-zinc-300 dark:bg-white/20" />
                <motion.span
                  className={cn('absolute inset-y-0 rounded-full', b.net >= 0 ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500')}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ type: 'spring', stiffness: 200, damping: 26 }}
                />
              </span>
              <span
                className={cn(
                  'tabular text-right text-[13px] font-medium whitespace-nowrap',
                  b.net > 0 ? 'text-emerald-600 dark:text-emerald-400' : b.net < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-400',
                )}
              >
                {b.net === 0 ? v.settled : formatMoney(b.net, { sign: true })}
              </span>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

function Settle() {
  const { store, memberById } = useLedger();
  const { transfers } = useBalances();
  const [paying, setPaying] = useState<string | null>(null);

  async function markPaid(transfer: Transfer) {
    const key = `${transfer.fromId}-${transfer.toId}`;
    setPaying(key);
    try {
      const { undo } = await store.apply([
        { op: 'settlement.create', id: newId(), settlement: { fromId: transfer.fromId, toId: transfer.toId, amount: transfer.amount, date: today() } },
      ]);
      toast.success(v.recorded(memberById.get(transfer.fromId)?.name ?? '', memberById.get(transfer.toId)?.name ?? '', formatMoney(transfer.amount)), {
        action: undoAction(store, undo),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPaying(null);
    }
  }

  return (
    <Frame icon={<HandCoins />} title={v.settle} aside={transfers.length > 0 ? v.transfers(transfers.length) : undefined}>
      {transfers.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/8 px-4 py-3 text-sm font-medium text-emerald-700 dark:text-emerald-300">
          <PartyPopper className="size-5 shrink-0" />
          {v.allSettled}
        </div>
      ) : (
        <ul className="space-y-2">
          {transfers.map((tr) => {
            const key = `${tr.fromId}-${tr.toId}`;
            return (
              <li key={key} className="flex items-center gap-3 rounded-2xl bg-zinc-50 py-2 pr-2 pl-3 dark:bg-white/4">
                <span className="flex shrink-0 -space-x-2">
                  <Avatar member={memberById.get(tr.fromId)} size="sm" className="ring-2 ring-zinc-50 dark:ring-zinc-800" />
                  <Avatar member={memberById.get(tr.toId)} size="sm" className="ring-2 ring-zinc-50 dark:ring-zinc-800" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="truncate">{memberById.get(tr.fromId)?.name}</span>
                    <ArrowRight className="size-3 shrink-0" />
                    <span className="truncate">{memberById.get(tr.toId)?.name}</span>
                  </p>
                  <p className="tabular text-[15px] font-semibold">{formatMoney(tr.amount)}</p>
                </div>
                <Button size="sm" variant="primary" loading={paying === key} icon={<Check className="size-3.5" />} onClick={() => void markPaid(tr)}>
                  {v.paid}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Frame>
  );
}

function Categories({ range, memberId }: { range: ViewRange; memberId: string | null }) {
  const { memberById } = useLedger();
  const scoped = useScoped(range, memberId, null);
  const { rows, total } = useMemo(() => {
    const sums = new Map<Category | null, number>();
    for (const e of scoped) sums.set(e.category, (sums.get(e.category) ?? 0) + shareOf(e, memberId));
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    return { rows: [...sums].filter(([, amount]) => amount > 0).sort((a, b) => b[1] - a[1]), total };
  }, [scoped, memberId]);
  const who = memberId ? memberById.get(memberId)?.name : null;

  return (
    <Frame icon={<ChartPie />} title={v.categories} aside={[who, rangeText(range)].filter(Boolean).join(' · ')}>
      {rows.length === 0 ? (
        <p className="py-3 text-center text-sm text-zinc-400">{v.empty}</p>
      ) : (
        <>
          <p className="tabular mb-3 text-2xl font-semibold tracking-tight">{formatMoney(total)}</p>
          <ul className="space-y-2.5">
            {rows.map(([category, amount], i) => {
              const ratio = total > 0 ? amount / total : 0;
              return (
                <li key={category ?? 'none'} className="flex items-center gap-3">
                  <CategoryIcon category={category} size="sm" className="size-8 text-base" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate font-medium">
                        {category ? categoryName(category) : ledger.overview.uncategorized}
                        <span className="tabular ml-1.5 text-xs font-normal text-zinc-400">{ratio < 0.01 ? '<1%' : `${Math.round(ratio * 100)}%`}</span>
                      </span>
                      <span className="tabular shrink-0 font-semibold">{formatMoney(amount)}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-white/6">
                      <motion.div
                        className={cn('h-full rounded-full', category ? 'bg-gradient-to-r from-brand-500 to-accent-400' : 'bg-zinc-300 dark:bg-zinc-600')}
                        initial={{ width: 0 }}
                        animate={{ width: `${ratio * 100}%` }}
                        transition={{ type: 'spring', stiffness: 160, damping: 24, delay: i * 0.04 }}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Frame>
  );
}

interface Bucket {
  key: string;
  label: string;
  total: number;
}

function buckets(expenses: Expense[], memberId: string | null, from: IsoDate, to: IsoDate): { monthly: boolean; list: Bucket[] } {
  const monthly = daysBetween(from, to) + 1 > 45;
  const totals = new Map<string, number>();
  for (const e of expenses) {
    const k = monthly ? e.date.slice(0, 7) : e.date;
    totals.set(k, (totals.get(k) ?? 0) + shareOf(e, memberId));
  }
  const list: Bucket[] = [];
  if (!monthly) {
    for (let d = from; d <= to; d = addDays(d, 1)) list.push({ key: d, label: shortDate(d), total: totals.get(d) ?? 0 });
    return { monthly, list };
  }
  const end = parseIsoDate(to);
  for (const cur = parseIsoDate(`${from.slice(0, 7)}-01`); cur <= end; cur.setMonth(cur.getMonth() + 1)) {
    const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
    list.push({ key: k, label: ledger.overview.month(cur.getMonth() + 1), total: totals.get(k) ?? 0 });
  }
  return { monthly, list: list.slice(-24) };
}

function Trend({ range, memberId, category }: { range: ViewRange; memberId: string | null; category: Category | null }) {
  const scoped = useScoped(range, memberId, category);
  const { monthly, list, max, total } = useMemo(() => {
    const oldest = scoped.reduce<IsoDate | null>((min, e) => (!min || e.date < min ? e.date : min), null);
    const newest = scoped.reduce<IsoDate | null>((max, e) => (!max || e.date > max ? e.date : max), null);
    const to = range.to ?? (newest && newest > today() ? newest : today());
    const from = range.from ?? (oldest && oldest < to ? oldest : addDays(to, -13));
    const result = buckets(scoped, memberId, from <= to ? from : to, to);
    return { ...result, max: Math.max(1, ...result.list.map((b) => b.total)), total: scoped.reduce((s, e) => s + shareOf(e, memberId), 0) };
  }, [scoped, range.from, range.to, memberId]);

  return (
    <Frame icon={<ChartColumnBig />} title={v.trend} aside={[category && categoryText(category), monthly ? v.perMonth : v.perDay].filter(Boolean).join(' · ')}>
      <p className="tabular mb-3 text-2xl font-semibold tracking-tight">{formatMoney(total)}</p>
      <div className="flex h-24 items-end gap-[3px]" role="img" aria-label={`${v.trend} ${formatMoney(total)}`}>
        {list.map((b, i) => (
          <div key={b.key} className="group relative flex h-full min-w-0 flex-1 items-end" title={`${b.label} ${formatMoney(b.total)}`}>
            <motion.div
              className={cn('w-full rounded-t-[4px] rounded-b-[2px]', b.total > 0 ? 'bg-gradient-to-t from-brand-500 to-accent-400' : 'bg-zinc-200 dark:bg-white/8')}
              initial={{ height: 0 }}
              animate={{ height: b.total > 0 ? `${Math.max(6, (b.total / max) * 100)}%` : 3 }}
              transition={{ type: 'spring', stiffness: 180, damping: 24, delay: Math.min(i, 30) * 0.012 }}
            />
          </div>
        ))}
      </div>
      <div className="tabular mt-1.5 flex justify-between text-[11px] text-zinc-400">
        <span>{list[0]?.label}</span>
        <span>{list.at(-1)?.label}</span>
      </div>
    </Frame>
  );
}

function scrollToTimeline() {
  const section = document.querySelector('[data-card=timeline]');
  if (section) window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - 72, behavior: 'smooth' });
}

function Transactions({ view, onNavigate }: { view: Extract<AssistantView, { kind: 'transactions' }>; onNavigate: () => void }) {
  const { memberById, setFilters } = useLedger();
  const scoped = useScoped(view, view.memberId, view.category);
  const matches = useMemo(() => {
    const needle = view.query?.trim().toLowerCase();
    const list = needle
      ? scoped.filter((e) =>
          [e.title, memberById.get(e.payerId)?.name ?? '', (e.amount / 100).toFixed(2)].some((s) => s.toLowerCase().includes(needle)),
        )
      : scoped;
    return [...list].sort(byNewest);
  }, [scoped, view.query, memberById]);
  const total = matches.reduce((s, e) => s + shareOf(e, view.memberId), 0);

  const showAll = () => {
    setFilters({
      range: view.from || view.to ? { key: 'custom', from: view.from ?? undefined, to: view.to ?? undefined } : { key: 'all' },
      memberId: view.memberId,
      category: view.category,
      query: view.query ?? '',
    });
    onNavigate();
    requestAnimationFrame(() => setTimeout(scrollToTimeline, 60));
  };

  return (
    <Frame icon={<ListFilter />} title={v.transactions} aside={matches.length > 0 ? `${rangeText(view)} · ${formatMoney(total)}` : undefined}>
      {matches.length === 0 ? (
        <p className="py-3 text-center text-sm text-zinc-400">{v.empty}</p>
      ) : (
        <>
          <ul className="-mx-1 divide-y divide-zinc-900/5 dark:divide-white/6">
            {matches.slice(0, 8).map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-1 py-2">
                <CategoryIcon category={e.category} size="sm" className="size-8 text-base" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{e.title}</p>
                  <p className="truncate text-xs text-zinc-500 dark:text-zinc-400">
                    {dateText(e.date)} · {t.paidBy(memberById.get(e.payerId)?.name ?? t.someone)}
                  </p>
                </div>
                <span className="tabular shrink-0 text-sm font-semibold">{formatMoney(e.amount)}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={showAll}
            className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-xl text-[13px] font-medium text-brand-600 transition hover:bg-brand-500/8 dark:text-brand-300"
          >
            {matches.length > 8 ? v.viewAll(matches.length) : v.viewInTimeline}
            <ChevronRight className="size-4" />
          </button>
        </>
      )}
    </Frame>
  );
}
