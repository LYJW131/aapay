import { ArrowRight, ChevronDown, ReceiptText } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { formatMoney } from '../../../shared/money.ts';
import type { Expense, IsoDate, Settlement } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Card, Empty } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { dayLabel, formatTime } from '../../lib/dates.ts';
import { useLedger } from './context.tsx';
import { ExpenseForm } from './ExpenseForm.tsx';
import { rangeLabel, type RangeFilter } from './range.ts';
import { SettlementDetail } from './Settlement.tsx';

interface Day {
  date: IsoDate;
  total: number;
  items: (Expense | Settlement)[];
}

const PAGE = 14;

/** 多日账本：按日期分组展示支出与还款，每天带小计 */
export function Timeline({ expenses, settlements, range }: { expenses: Expense[]; settlements: Settlement[]; range: RangeFilter }) {
  const [visible, setVisible] = useState(PAGE);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [viewing, setViewing] = useState<Settlement | null>(null);

  const days = useMemo(() => {
    const map = new Map<IsoDate, Day>();
    const day = (date: IsoDate) => {
      let d = map.get(date);
      if (!d) map.set(date, (d = { date, total: 0, items: [] }));
      return d;
    };
    for (const e of expenses) {
      const d = day(e.date);
      d.total += e.amount;
      d.items.push(e);
    }
    for (const s of settlements) day(s.date).items.push(s);
    for (const d of map.values()) d.items.sort((a, b) => b.createdAt - a.createdAt);
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  }, [expenses, settlements]);

  return (
    <Card
      title="账目明细"
      icon={<ReceiptText />}
      action={<span className="text-xs text-zinc-400">{rangeLabel(range)} · {days.length} 天</span>}
    >
      {days.length === 0 ? (
        <Empty icon={<ReceiptText />} title="这段时间还没有账目" hint="换个时间范围看看，或者记一笔吧" />
      ) : (
        <div className="space-y-5">
          <AnimatePresence initial={false}>
            {days.slice(0, visible).map((d) => {
              const label = dayLabel(d.date);
              return (
                <motion.section key={d.date} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <header className="sticky top-14 z-10 -mx-2 mb-1 flex items-baseline justify-between rounded-xl bg-surface/90 px-2 py-1.5 backdrop-blur">
                    <h3 className="text-sm font-semibold">
                      {label.title}
                      <span className="ml-2 text-xs font-normal text-zinc-400">{label.sub}</span>
                    </h3>
                    <span className="tabular text-xs text-zinc-500 dark:text-zinc-400">
                      {d.total > 0 ? `支出 ${formatMoney(d.total)}` : ''}
                    </span>
                  </header>
                  <ul className="-mx-2">
                    <AnimatePresence initial={false}>
                      {d.items.map((item) => (
                        <motion.li
                          key={item.id}
                          layout="position"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.22 }}
                        >
                          {'payerId' in item ? (
                            <ExpenseRow expense={item} onClick={() => setEditing(item)} />
                          ) : (
                            <SettlementRow settlement={item} onClick={() => setViewing(item)} />
                          )}
                        </motion.li>
                      ))}
                    </AnimatePresence>
                  </ul>
                </motion.section>
              );
            })}
          </AnimatePresence>
          {days.length > visible && (
            <Button variant="ghost" className="w-full" icon={<ChevronDown className="size-4" />} onClick={() => setVisible((v) => v + PAGE)}>
              查看更早的 {days.length - visible} 天
            </Button>
          )}
        </div>
      )}

      <Sheet open={!!editing} onClose={() => setEditing(null)} title="编辑支出">
        {editing && <ExpenseForm key={editing.id} expense={editing} onDone={() => setEditing(null)} />}
      </Sheet>
      <Sheet open={!!viewing} onClose={() => setViewing(null)} title="还款详情">
        {viewing && <SettlementDetail settlement={viewing} onDone={() => setViewing(null)} />}
      </Sheet>
    </Card>
  );
}

function ExpenseRow({ expense, onClick }: { expense: Expense; onClick: () => void }) {
  const { memberById } = useLedger();
  const payer = memberById.get(expense.payerId);
  const n = expense.shares.length;
  const each = expense.shares.at(-1)?.amount ?? 0;
  const names = expense.shares.map((s) => memberById.get(s.memberId)?.name ?? '?');
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-zinc-900/3 active:bg-zinc-900/5 dark:hover:bg-white/4">
      <Avatar member={payer} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[15px] font-medium">{expense.title}</span>
          <span className="tabular shrink-0 text-[15px] font-semibold">{formatMoney(expense.amount)}</span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="truncate" title={names.join('、')}>
            {payer?.name ?? '已删除成员'} 付款 · {n === memberById.size && n > 1 ? '全员' : names.join('、')}
          </span>
          <span className="tabular shrink-0">
            {n > 1 ? `每人 ${formatMoney(each)}` : ''} · {formatTime(expense.createdAt)}
          </span>
        </div>
      </div>
    </button>
  );
}

function SettlementRow({ settlement, onClick }: { settlement: Settlement; onClick: () => void }) {
  const { memberById } = useLedger();
  const from = memberById.get(settlement.fromId);
  const to = memberById.get(settlement.toId);
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-zinc-900/3 active:bg-zinc-900/5 dark:hover:bg-white/4">
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
          <span className="truncate">还款{settlement.note ? ` · ${settlement.note}` : ''}</span>
          <span className="tabular shrink-0">{formatTime(settlement.createdAt)}</span>
        </div>
      </div>
    </button>
  );
}
