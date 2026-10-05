import { ArrowRight, Check, HandCoins, PartyPopper, Plus, Trash2 } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { centsToInput, formatMoney, parseAmount } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { computeBalances, suggestTransfers, type Transfer } from '../../../shared/settle.ts';
import type { Settlement } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Card, Empty, Label } from '../../components/Card.tsx';
import { Collapse, Reveal } from '../../components/Collapse.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { common } from '../../i18n/common.ts';
import { expense } from '../../i18n/expense.ts';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { formatDateTime, today } from '../../lib/dates.ts';
import { useLedger } from './context.tsx';
import { MemberChip } from './ExpenseForm.tsx';

export function SettlementCard() {
  const { snapshot, memberById, store } = useLedger();
  const [draft, setDraft] = useState<Partial<Transfer> | null>(null);
  const [paying, setPaying] = useState<string | null>(null);

  const { balances, transfers, maxAbs } = useMemo(() => {
    const balances = computeBalances(snapshot.members, snapshot.expenses, snapshot.settlements)
      .filter((b) => memberById.has(b.memberId));
    return {
      balances,
      // 按金额排：还掉一笔后其余转账的相对顺序通常不变，不会在收起动画的同时互换位置
      transfers: suggestTransfers(balances).sort(
        (a, b) => b.amount - a.amount || `${a.fromId}-${a.toId}`.localeCompare(`${b.fromId}-${b.toId}`),
      ),
      maxAbs: Math.max(1, ...balances.map((b) => Math.abs(b.net))),
    };
  }, [snapshot, memberById]);

  async function markPaid(t: Transfer) {
    const key = `${t.fromId}-${t.toId}`;
    setPaying(key);
    try {
      const message = await store.mutate(
        api.ledger.settlements.$post({ json: { fromId: t.fromId, toId: t.toId, amount: t.amount, date: today() } }),
      );
      const id = message.event.type === 'settlement.saved' ? message.event.settlement.id : null;
      toast.success(expense.recorded(memberById.get(t.fromId)?.name ?? '', memberById.get(t.toId)?.name ?? '', formatMoney(t.amount)), {
        action: id
          ? {
              label: expense.settle.undo,
              onClick: () =>
                void store.mutate(api.ledger.settlements[':id'].$delete({ param: { id } })).catch((err) =>
                  toast.error(errorMessage(err)),
                ),
            }
          : undefined,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPaying(null);
    }
  }

  const hasActivity = snapshot.expenses.length > 0 || snapshot.settlements.length > 0;

  return (
    <>
      <Card
        id="settlement"
        title={expense.settle.card}
        icon={<HandCoins />}
        action={
          snapshot.members.length > 1 && (
            <Button size="sm" variant="soft" icon={<Plus className="size-3.5" />} onClick={() => setDraft({})}>
              {expense.settle.record}
            </Button>
          )
        }
      >
        <Collapse open={!hasActivity}>
          <Empty icon={<HandCoins />} title={expense.settle.emptyTitle} hint={expense.settle.emptyHint} />
        </Collapse>
        <Collapse open={hasActivity}>
          <p className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
            {transfers.length ? expense.settle.transfersNeeded(transfers.length) : expense.settle.everyoneSettled}
          </p>
          <Collapse open={transfers.length === 0} className="pb-2">
            <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/8 px-4 py-4 text-emerald-700 dark:text-emerald-300">
              <PartyPopper className="size-5 shrink-0" />
              <span className="text-sm font-medium">{expense.settle.allSettled}</span>
            </div>
          </Collapse>
          <ul>
            <AnimatePresence initial={false}>
              {transfers.map((t) => {
                const from = memberById.get(t.fromId);
                const to = memberById.get(t.toId);
                const key = `${t.fromId}-${t.toId}`;
                return (
                  // 余额变化后转账可能重新排序，layout 让它们滑到新位置而不是瞬间互换
                  <Reveal as="li" key={key} layout="position" className="pb-2">
                    <div className="flex items-center gap-3 rounded-2xl bg-zinc-50 py-2.5 pr-2.5 pl-3 dark:bg-white/4">
                      <span className="flex shrink-0 -space-x-2.5">
                        <Avatar member={from} className="ring-[3px] ring-zinc-50 dark:ring-[#26262c]" />
                        <Avatar member={to} className="ring-[3px] ring-zinc-50 dark:ring-[#26262c]" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex min-w-0 items-center gap-1 text-[13px] text-zinc-500 dark:text-zinc-400">
                          <span className="truncate">{from?.name}</span>
                          <ArrowRight className="size-3.5 shrink-0" />
                          <span className="truncate">{to?.name}</span>
                        </p>
                        <button
                          onClick={() => setDraft({ ...t })}
                          className="tabular text-base font-semibold hover:underline"
                          title={expense.settle.editAmount}
                        >
                          {formatMoney(t.amount)}
                        </button>
                      </div>
                      <Button
                        size="sm"
                        variant="primary"
                        loading={paying === key}
                        onClick={() => markPaid(t)}
                        icon={<Check className="size-3.5" />}
                      >
                        {expense.settle.paid}
                      </Button>
                    </div>
                  </Reveal>
                );
              })}
            </AnimatePresence>
          </ul>

          <p className="mt-3 mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">{expense.settle.balances}</p>
          <ul className="-mb-1.5">
            <AnimatePresence initial={false}>
              {balances.map((b) => {
                const m = memberById.get(b.memberId);
                const pct = (Math.abs(b.net) / maxAbs) * 50;
                return (
                  <Reveal as="li" key={b.memberId} className="pt-1 pb-2.5">
                    <div className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] items-center gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar member={m} size="xs" />
                        <span className="truncate text-sm">{m?.name}</span>
                      </span>
                      <span className="relative h-2 rounded-full bg-zinc-100 dark:bg-white/6" aria-hidden>
                        <span className="absolute inset-y-0 left-1/2 w-px bg-zinc-300 dark:bg-white/20" />
                        {/* 正负各一条：应收应付翻转时一条缩回、另一条长出，而不是整条瞬间跳到中线另一侧 */}
                        <span
                          className="absolute inset-y-0 left-1/2 rounded-full bg-emerald-500 transition-[width] duration-300"
                          style={{ width: `${b.net > 0 ? pct : 0}%` }}
                        />
                        <span
                          className="absolute inset-y-0 right-1/2 rounded-full bg-rose-500 transition-[width] duration-300"
                          style={{ width: `${b.net < 0 ? pct : 0}%` }}
                        />
                      </span>
                      <span
                        className={cn(
                          'tabular w-28 text-right text-[13px] font-medium whitespace-nowrap',
                          b.net > 0 ? 'text-emerald-600 dark:text-emerald-400' : b.net < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-400',
                        )}
                      >
                        {b.net > 0 ? expense.settle.owed(formatMoney(b.net)) : b.net < 0 ? expense.settle.owes(formatMoney(-b.net)) : expense.settle.settled}
                      </span>
                    </div>
                  </Reveal>
                );
              })}
            </AnimatePresence>
          </ul>
        </Collapse>
      </Card>

      <Sheet open={!!draft} onClose={() => setDraft(null)} title={expense.settle.record} description={expense.settle.sheetDescription}>
        {draft && <SettlementForm draft={draft} onDone={() => setDraft(null)} />}
      </Sheet>
    </>
  );
}

function SettlementForm({ draft, onDone }: { draft: Partial<Transfer>; onDone: () => void }) {
  const { snapshot, store, memberById } = useLedger();
  const [fromId, setFromId] = useState(draft.fromId ?? '');
  const [toId, setToId] = useState(draft.toId ?? '');
  const [amount, setAmount] = useState(draft.amount ? centsToInput(draft.amount) : '');
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cents = parseAmount(amount);
    if (!fromId || !toId) return toast.error(expense.settle.partiesRequired);
    if (fromId === toId) return toast.error(expense.settle.samePerson);
    if (!cents) return toast.error(expense.settle.invalidAmount);
    setSaving(true);
    try {
      await store.mutate(api.ledger.settlements.$post({ json: { fromId, toId, amount: cents, date, note: note.trim() || null } }));
      toast.success(expense.recorded(memberById.get(fromId)?.name ?? '', memberById.get(toId)?.name ?? '', formatMoney(cents)));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 pb-1">
      <div>
        <Label>{expense.paidBy}</Label>
        <div className="flex flex-wrap gap-2">
          {snapshot.members.map((m) => (
            <MemberChip
              key={m.id}
              member={m}
              active={fromId === m.id}
              onClick={() => {
                setFromId(m.id);
                if (toId === m.id) setToId('');
              }}
            />
          ))}
        </div>
      </div>
      <div>
        <Label>{expense.settle.paidTo}</Label>
        {/* 付款人置灰而不是从列表里拿掉，换付款人时其余成员不会重新换行挪位置 */}
        <div className="flex flex-wrap gap-2">
          {snapshot.members.map((m) => (
            <MemberChip key={m.id} member={m} active={toId === m.id} disabled={m.id === fromId} onClick={() => setToId(m.id)} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{expense.amount}</Label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="field tabular" />
        </div>
        <div>
          <Label>{expense.date}</Label>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="field tabular px-3" />
        </div>
      </div>
      <div>
        <Label>{expense.settle.noteOptional}</Label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.note} placeholder={expense.settle.notePlaceholder} className="field" />
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={saving} icon={<Check className="size-4" />}>
        {expense.settle.record}
      </Button>
    </form>
  );
}

export function SettlementDetail({ settlement, onDone }: { settlement: Settlement; onDone: () => void }) {
  const { store, memberById } = useLedger();
  const [deleting, setDeleting] = useState(false);
  const from = memberById.get(settlement.fromId);
  const to = memberById.get(settlement.toId);

  async function remove() {
    setDeleting(true);
    try {
      await store.mutate(api.ledger.settlements[':id'].$delete({ param: { id: settlement.id } }));
      toast.success(expense.settle.deleted);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5 pb-1">
      <div className="flex items-center justify-center gap-4 py-2">
        <div className="flex flex-col items-center gap-1.5">
          <Avatar member={from} size="lg" />
          <span className="text-sm font-medium">{from?.name}</span>
        </div>
        <div className="flex flex-col items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <span className="tabular text-xl font-semibold">{formatMoney(settlement.amount)}</span>
          <ArrowRight className="size-5" />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <Avatar member={to} size="lg" />
          <span className="text-sm font-medium">{to?.name}</span>
        </div>
      </div>
      <dl className="divide-y divide-zinc-100 rounded-2xl bg-zinc-50 px-4 text-sm dark:divide-white/5 dark:bg-white/4">
        <div className="flex justify-between py-3">
          <dt className="text-zinc-500">{expense.date}</dt>
          <dd>{settlement.date === today() ? common.today : settlement.date}</dd>
        </div>
        {settlement.note && (
          <div className="flex justify-between py-3">
            <dt className="text-zinc-500">{expense.settle.note}</dt>
            <dd>{settlement.note}</dd>
          </div>
        )}
        <div className="flex justify-between py-3">
          <dt className="text-zinc-500">{expense.settle.recordedAt}</dt>
          <dd className="tabular">{formatDateTime(settlement.createdAt)}</dd>
        </div>
      </dl>
      <Button variant="danger" size="lg" className="w-full" onClick={remove} loading={deleting} icon={<Trash2 className="size-4" />}>
        {expense.settle.delete}
      </Button>
    </div>
  );
}
