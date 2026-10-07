import { ArrowRight, ChevronDown, Download, ReceiptText, Search, Tag, X } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useMemo, useState } from 'react';
import { CATEGORY_EMOJI } from '../../../shared/categories.ts';
import { splitOf } from '../../../shared/ledger.ts';
import { centsToInput, formatMoney } from '../../../shared/money.ts';
import type { Expense, IsoDate, Member, Settlement } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Card, Empty } from '../../components/Card.tsx';
import { CategoryIcon, categoryName } from '../../components/CategoryIcon.tsx';
import { Collapse, Reveal } from '../../components/Collapse.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { common } from '../../i18n/common.ts';
import { expense as expenseText } from '../../i18n/expense.ts';
import { ledger } from '../../i18n/ledger.ts';
import { cn } from '../../lib/cn.ts';
import { downloadText, toCsv } from '../../lib/csv.ts';
import { dayLabel, formatTime, today } from '../../lib/dates.ts';
import { useLedger } from './context.tsx';
import { ExpenseForm } from './ExpenseForm.tsx';
import type { CategoryFilter } from './filters.ts';
import { useHighlighted } from './highlight.ts';
import { rangeLabel, type RangeFilter } from './range.ts';
import { SettlementDetail } from './Settlement.tsx';

interface Day {
  date: IsoDate;
  total: number;
  items: (Expense | Settlement)[];
}

const t = ledger.timeline;

const PAGE = 14;

function matches(item: Expense | Settlement, query: string, memberById: Map<string, Member>) {
  const names = ('payerId' in item ? [item.payerId, ...item.shares.map((s) => s.memberId)] : [item.fromId, item.toId]).map(
    (id) => memberById.get(id)?.name ?? '',
  );
  const text = 'payerId' in item ? item.title : (item.note ?? '');
  const amount = (item.amount / 100).toFixed(2);
  return [text, ...names, amount, amount.replace(/\.00$/, '')].some((v) => v.toLowerCase().includes(query));
}

const yuan = (cents: number) => (cents / 100).toFixed(2);

function exportCsv(days: Day[], ledgerName: string, memberById: Map<string, Member>) {
  const name = (id: string) => memberById.get(id)?.name ?? t.deletedMember;
  const rows = days.flatMap((d) =>
    d.items.map((item) =>
      'payerId' in item
        ? [
            item.date,
            t.csv.expense,
            item.title,
            item.category ? categoryName(item.category) : ledger.overview.uncategorized,
            yuan(item.amount),
            name(item.payerId),
            '',
            item.shares.map((s) => `${name(s.memberId)} ${yuan(s.amount)}`).join(t.csv.separator),
          ]
        : [item.date, t.csv.settlement, item.note ?? '', '', yuan(item.amount), name(item.fromId), name(item.toId), ''],
    ),
  );
  downloadText(t.exportName(ledgerName, today()), toCsv([t.csv.columns, ...rows]), 'text/csv;charset=utf-8');
}

function CategoryTag({ category, onClear }: { category: Exclude<CategoryFilter, null>; onClear: () => void }) {
  const label = category === 'none' ? ledger.overview.uncategorized : categoryName(category);
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={t.clearCategory(label)}
      className="flex h-7 max-w-36 items-center gap-1 rounded-full bg-brand-500/10 pr-1.5 pl-2 text-xs font-medium text-brand-600 transition hover:bg-brand-500/15 dark:text-brand-300"
    >
      {category === 'none' ? <Tag className="size-3.5 shrink-0" /> : <span className="text-sm leading-none">{CATEGORY_EMOJI[category]}</span>}
      <span className="truncate">{label}</span>
      <X className="size-3.5 shrink-0 opacity-70" />
    </button>
  );
}

export function Timeline({ expenses, settlements, range }: { expenses: Expense[]; settlements: Settlement[]; range: RangeFilter }) {
  const [visible, setVisible] = useState(PAGE);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const [viewing, setViewing] = useState<Settlement | null>(null);
  const { memberById, snapshot, filters, setFilters } = useLedger();
  const { query, category } = filters;
  const setQuery = (value: string) => setFilters({ query: value });
  const editing = editingId ? snapshot.expenses.find((e) => e.id === editingId) : undefined;
  const needle = query.trim().toLowerCase();

  const days = useMemo(() => {
    const keep = (item: Expense | Settlement) => !needle || matches(item, needle, memberById);
    const map = new Map<IsoDate, Day>();
    const day = (date: IsoDate) => {
      let d = map.get(date);
      if (!d) map.set(date, (d = { date, total: 0, items: [] }));
      return d;
    };
    for (const e of expenses) {
      if (!keep(e)) continue;
      const d = day(e.date);
      d.total += e.amount;
      d.items.push(e);
    }
    for (const s of settlements) if (keep(s)) day(s.date).items.push(s);
    for (const d of map.values()) d.items.sort((a, b) => b.createdAt - a.createdAt);
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [expenses, settlements, needle, memberById]);

  return (
    <>
      <Card
        id="timeline"
        title={t.title}
        icon={<ReceiptText />}
        action={
          <div className="flex items-center gap-1.5">
            {category && <CategoryTag category={category} onClear={() => setFilters({ category: null })} />}
            <span className={cn('text-xs whitespace-nowrap text-zinc-400', category && 'max-sm:hidden')}>
              {rangeLabel(range)} · {t.dayCount(days.length)}
            </span>
            <button
              type="button"
              onClick={() => exportCsv(days, snapshot.ledger.name, memberById)}
              disabled={days.length === 0}
              aria-label={t.export}
              title={t.export}
              className="-mr-1.5 flex size-8 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-900/5 hover:text-zinc-600 disabled:opacity-40 dark:hover:bg-white/8 dark:hover:text-zinc-200"
            >
              <Download className="size-4" />
            </button>
          </div>
        }
      >
        <Collapse open={expenses.length > 0 || settlements.length > 0} className="pb-4">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t.search}
              aria-label={t.searchLabel}
              className="field pr-10 pl-10 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t.clearSearch}
                className="absolute top-1/2 right-2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-zinc-400 transition hover:bg-zinc-900/5 hover:text-zinc-600 dark:hover:bg-white/8 dark:hover:text-zinc-200"
              >
                <X className="size-4" />
              </button>
            )}
          </div>
        </Collapse>
        {/* 每块自带 pb-5 作间距（随增删动画一起伸缩），最后一块多出的 pb-5 由 -mb-5 抵掉 */}
        <div className="-mb-5">
          <Collapse open={days.length === 0} className="pb-5">
            {needle ? (
              <Empty icon={<Search />} title={t.noMatch(query.trim())} hint={t.noMatchHint} />
            ) : (
              <Empty icon={<ReceiptText />} title={t.empty} hint={t.emptyHint} />
            )}
          </Collapse>
          <AnimatePresence initial={false}>
            {days.slice(0, visible).map((d) => {
              const label = dayLabel(d.date);
              return (
                <Reveal as="section" key={d.date} layout="position" className="pb-5">
                  <header className="sticky top-14 z-10 -mx-2 mb-1 flex items-baseline justify-between rounded-xl bg-surface/90 px-2 py-1.5 backdrop-blur">
                    <h3 className="text-sm font-semibold">
                      {label.title}
                      <span className="ml-2 text-xs font-normal text-zinc-400">{label.sub}</span>
                    </h3>
                    <span className="tabular text-xs text-zinc-500 dark:text-zinc-400">
                      {d.total > 0 ? t.daySpent(formatMoney(d.total)) : ''}
                    </span>
                  </header>
                  <ul className="-mx-2">
                    <AnimatePresence initial={false}>
                      {d.items.map((item) => (
                        <Reveal as="li" key={item.id} layout="position">
                          {'payerId' in item ? (
                            <ExpenseRow expense={item} onClick={() => setEditingId(item.id)} />
                          ) : (
                            <SettlementRow settlement={item} onClick={() => setViewing(item)} />
                          )}
                        </Reveal>
                      ))}
                    </AnimatePresence>
                  </ul>
                </Reveal>
              );
            })}
          </AnimatePresence>
          <Collapse open={days.length > visible} className="pb-5">
            <Button variant="ghost" className="w-full" icon={<ChevronDown className="size-4" />} onClick={() => setVisible((v) => v + PAGE)}>
              {t.more(days.length - visible)}
            </Button>
          </Collapse>
        </div>
      </Card>

      <Sheet open={!!editing} onClose={() => setEditingId(null)} title={t.editExpense}>
        {editing && (
          <ExpenseForm
            key={`${editing.id}:${reloads}`}
            expense={editing}
            onReload={() => setReloads((n) => n + 1)}
            onDone={() => setEditingId(null)}
          />
        )}
      </Sheet>
      <Sheet open={!!viewing} onClose={() => setViewing(null)} title={t.settlementDetail}>
        {viewing && <SettlementDetail settlement={viewing} onDone={() => setViewing(null)} />}
      </Sheet>
    </>
  );
}

const rowClass = 'flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-zinc-900/3 active:bg-zinc-900/5 dark:hover:bg-white/4';

function ExpenseRow({ expense, onClick }: { expense: Expense; onClick: () => void }) {
  const { memberById, snapshot } = useLedger();
  const lit = useHighlighted(expense.id);
  const payer = memberById.get(expense.payerId);
  const n = expense.shares.length;
  const each = expense.shares.at(-1)?.amount ?? 0;
  const custom = splitOf(expense, snapshot.members).mode === 'exact';
  const name = (id: string) => memberById.get(id)?.name ?? '?';
  const names = expense.shares.map((s) => name(s.memberId)).join(common.listSeparator);
  const who = custom
    ? expense.shares.map((s) => `${name(s.memberId)} ¥${centsToInput(s.amount)}`).join(common.listSeparator)
    : n === memberById.size && n > 1
      ? t.everyone
      : names;
  return (
    <button onClick={onClick} className={cn(rowClass, lit && 'glow')}>
      <span className="relative shrink-0">
        <CategoryIcon category={expense.category} />
        <span className="absolute -right-1 -bottom-1 flex rounded-full bg-surface ring-2 ring-surface">
          <Avatar member={payer} size="2xs" />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[15px] font-medium">{expense.title}</span>
          <span className="tabular shrink-0 text-[15px] font-semibold">{formatMoney(expense.amount)}</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="truncate" title={custom ? who : names}>
            {t.paidBy(payer?.name ?? t.deletedMember)} · {who}
          </span>
          <span className="tabular shrink-0">
            {custom ? expenseText.form.customSplit : n > 1 ? t.each(formatMoney(each)) : ''} · {formatTime(expense.createdAt)}
          </span>
        </div>
      </div>
    </button>
  );
}

function SettlementRow({ settlement, onClick }: { settlement: Settlement; onClick: () => void }) {
  const { memberById } = useLedger();
  const lit = useHighlighted(settlement.id);
  const from = memberById.get(settlement.fromId);
  const to = memberById.get(settlement.toId);
  return (
    <button onClick={onClick} className={cn(rowClass, lit && 'glow')}>
      <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
        <ArrowRight className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[15px] font-medium">
            {from?.name} → {to?.name}
          </span>
          <span className="tabular shrink-0 text-[15px] font-semibold text-emerald-600 dark:text-emerald-400">
            {formatMoney(settlement.amount)}
          </span>
        </div>
        <div className="mt-0.5 flex justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="truncate">{t.settlement}{settlement.note ? ` · ${settlement.note}` : ''}</span>
          <span className="tabular shrink-0">{formatTime(settlement.createdAt)}</span>
        </div>
      </div>
    </button>
  );
}
