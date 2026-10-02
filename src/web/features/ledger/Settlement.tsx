import { ArrowRight, Check, HandCoins, PartyPopper, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { centsToInput, formatMoney, parseAmount } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import { computeBalances, suggestTransfers, type Transfer } from '../../../shared/settle.ts';
import type { Settlement } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Card, Empty, Label } from '../../components/Card.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { dayLabel, formatDateTime, today } from '../../lib/dates.ts';
import { useLedger } from './context.tsx';
import { MemberChip } from './ExpenseForm.tsx';

/** 结算：根据全部账目与已记录的还款，计算每人净额与最少转账方案 */
export function SettlementCard() {
  const { snapshot, memberById, store } = useLedger();
  const [draft, setDraft] = useState<Partial<Transfer> | null>(null);
  const [paying, setPaying] = useState<string | null>(null);

  const { balances, transfers, maxAbs } = useMemo(() => {
    const balances = computeBalances(snapshot.members, snapshot.expenses, snapshot.settlements)
      .filter((b) => memberById.has(b.memberId))
      .sort((a, b) => b.net - a.net);
    return {
      balances,
      transfers: suggestTransfers(balances),
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
      toast.success(`已记录 ${memberById.get(t.fromId)?.name} → ${memberById.get(t.toId)?.name} ${formatMoney(t.amount)}`, {
        action: id
          ? {
              label: '撤销',
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
    <Card
      title="结算"
      icon={<HandCoins />}
      action={
        snapshot.members.length > 1 && (
          <Button size="sm" variant="soft" icon={<Plus className="size-3.5" />} onClick={() => setDraft({})}>
            记录还款
          </Button>
        )
      }
    >
      {!hasActivity ? (
        <Empty icon={<HandCoins />} title="还没有需要结算的账目" hint="记账后，这里会自动算出谁该给谁多少钱" />
      ) : (
        <div className="space-y-5">
          <div>
            <p className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">
              {transfers.length ? `只需 ${transfers.length} 笔转账即可结清` : '每个人都已结清'}
            </p>
            {transfers.length === 0 ? (
              <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/8 px-4 py-4 text-emerald-700 dark:text-emerald-300">
                <PartyPopper className="size-5 shrink-0" />
                <span className="text-sm font-medium">账已算清，没有待结算的转账</span>
              </div>
            ) : (
              <ul className="space-y-2">
                {transfers.map((t) => {
                  const from = memberById.get(t.fromId);
                  const to = memberById.get(t.toId);
                  const key = `${t.fromId}-${t.toId}`;
                  return (
                    <li key={key} className="flex items-center gap-3 rounded-2xl bg-zinc-50 py-2.5 pr-2.5 pl-3 dark:bg-white/4">
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
                          title="修改金额后记录"
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
                        已付
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-2 text-[13px] font-medium text-zinc-500 dark:text-zinc-400">每人净额</p>
            <ul className="space-y-1.5">
              {balances.map((b) => {
                const m = memberById.get(b.memberId);
                const pct = (Math.abs(b.net) / maxAbs) * 50;
                return (
                  <li key={b.memberId} className="grid grid-cols-[minmax(0,6.5rem)_1fr_auto] items-center gap-3 py-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar member={m} size="xs" />
                      <span className="truncate text-sm">{m?.name}</span>
                    </span>
                    <span className="relative h-2 rounded-full bg-zinc-100 dark:bg-white/6" aria-hidden>
                      <span className="absolute inset-y-0 left-1/2 w-px bg-zinc-300 dark:bg-white/20" />
                      {b.net !== 0 && (
                        <span
                          className={cn(
                            'absolute inset-y-0 rounded-full',
                            b.net > 0 ? 'left-1/2 bg-emerald-500' : 'right-1/2 bg-rose-500',
                          )}
                          style={{ width: `${pct}%` }}
                        />
                      )}
                    </span>
                    <span
                      className={cn(
                        'tabular w-24 text-right text-[13px] font-medium',
                        b.net > 0 ? 'text-emerald-600 dark:text-emerald-400' : b.net < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-400',
                      )}
                    >
                      {b.net > 0 ? `应收 ${formatMoney(b.net)}` : b.net < 0 ? `应付 ${formatMoney(-b.net)}` : '已结清'}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      <Sheet open={!!draft} onClose={() => setDraft(null)} title="记录还款" description="记下谁向谁支付了多少，结算会自动更新">
        {draft && <SettlementForm draft={draft} onDone={() => setDraft(null)} />}
      </Sheet>
    </Card>
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
    if (!fromId || !toId) return toast.error('请选择付款人和收款人');
    if (fromId === toId) return toast.error('付款人和收款人不能是同一个人');
    if (!cents) return toast.error('请输入有效金额');
    setSaving(true);
    try {
      await store.mutate(api.ledger.settlements.$post({ json: { fromId, toId, amount: cents, date, note: note.trim() || null } }));
      toast.success(`已记录 ${memberById.get(fromId)?.name} → ${memberById.get(toId)?.name} ${formatMoney(cents)}`);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5 pb-1">
      <div>
        <Label>谁付的钱</Label>
        <div className="flex flex-wrap gap-2">
          {snapshot.members.map((m) => (
            <MemberChip key={m.id} member={m} active={fromId === m.id} onClick={() => setFromId(m.id)} />
          ))}
        </div>
      </div>
      <div>
        <Label>付给了谁</Label>
        <div className="flex flex-wrap gap-2">
          {snapshot.members
            .filter((m) => m.id !== fromId)
            .map((m) => (
              <MemberChip key={m.id} member={m} active={toId === m.id} onClick={() => setToId(m.id)} />
            ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>金额</Label>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="field tabular" />
        </div>
        <div>
          <Label>日期</Label>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="field tabular px-3" />
        </div>
      </div>
      <div>
        <Label>备注（可选）</Label>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={LIMITS.note} placeholder="例如：微信转账" className="field" />
      </div>
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={saving} icon={<Check className="size-4" />}>
        记录还款
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
      toast.success('已删除这笔还款');
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
          <dt className="text-zinc-500">日期</dt>
          <dd>{dayLabel(settlement.date).title === '今天' ? '今天' : settlement.date}</dd>
        </div>
        {settlement.note && (
          <div className="flex justify-between py-3">
            <dt className="text-zinc-500">备注</dt>
            <dd>{settlement.note}</dd>
          </div>
        )}
        <div className="flex justify-between py-3">
          <dt className="text-zinc-500">记录于</dt>
          <dd className="tabular">{formatDateTime(settlement.createdAt)}</dd>
        </div>
      </dl>
      <Button variant="danger" size="lg" className="w-full" onClick={remove} loading={deleting} icon={<Trash2 className="size-4" />}>
        删除这笔还款
      </Button>
    </div>
  );
}
