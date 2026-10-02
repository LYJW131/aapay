import { Check, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { centsToInput, formatMoney, parseAmount, splitEvenly } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type { Expense } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { api, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { addDays, today } from '../../lib/dates.ts';
import { load, save } from '../../lib/storage.ts';
import { useLedger } from './context.tsx';

interface Remembered {
  payerId: string;
  participantIds: string[];
  at: number;
}

/** 新增或编辑一笔支出。新增时会记住上次的付款人与参与者。 */
export function ExpenseForm({ expense, onDone }: { expense?: Expense; onDone?: () => void }) {
  const { snapshot, store, key } = useLedger();
  const { members } = snapshot;

  const [initial] = useState(() => {
    if (expense) {
      return {
        payerId: expense.payerId,
        participantIds: expense.shares.map((s) => s.memberId),
      };
    }
    const remembered = load<Remembered | null>(key('expense-defaults'), null);
    const ids = new Set(members.map((m) => m.id));
    // 上次之后新加入的成员默认也参与
    const participantIds = remembered
      ? [
          ...remembered.participantIds.filter((id) => ids.has(id)),
          ...members.filter((m) => m.createdAt > remembered.at).map((m) => m.id),
        ]
      : members.map((m) => m.id);
    return { payerId: remembered && ids.has(remembered.payerId) ? remembered.payerId : '', participantIds };
  });

  const [amount, setAmount] = useState(expense ? centsToInput(expense.amount) : '');
  const [title, setTitle] = useState(expense?.title ?? '');
  const [date, setDate] = useState(expense?.date ?? today());
  const [payerId, setPayerId] = useState(initial.payerId);
  const [selected, setSelected] = useState(() => new Set(initial.participantIds));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const cents = parseAmount(amount);
  const participantIds = members.filter((m) => selected.has(m.id)).map((m) => m.id);
  const shares = cents ? splitEvenly(cents, participantIds) : [];
  const allSelected = members.length > 0 && participantIds.length === members.length;

  const suggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of snapshot.expenses.slice(0, 200)) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
    const recent = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return [...new Set([...recent, '早餐', '午饭', '晚饭', '打车', '超市', '咖啡'])].slice(0, 6);
  }, [snapshot.expenses]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cents) return toast.error('请输入有效金额（最多两位小数）');
    if (!title.trim()) return toast.error('请填写用途');
    if (!payerId) return toast.error('请选择付款人');
    if (participantIds.length === 0) return toast.error('请至少选择一位参与者');

    const input = { title: title.trim(), amount: cents, payerId, date, participantIds };
    setSaving(true);
    try {
      if (expense) {
        await store.mutate(api.ledger.expenses[':id'].$patch({ param: { id: expense.id }, json: input }));
        toast.success('已保存修改');
      } else {
        await store.mutate(api.ledger.expenses.$post({ json: input }));
        save(key('expense-defaults'), { payerId, participantIds, at: Date.now() } satisfies Remembered);
        toast.success(`已记录 ${input.title} ${formatMoney(cents)}`);
        setAmount('');
        setTitle('');
      }
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!expense) return;
    setDeleting(true);
    try {
      await store.mutate(api.ledger.expenses[':id'].$delete({ param: { id: expense.id } }));
      toast.success(`已删除 ${expense.title}`);
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  if (members.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500">先添加成员，才能开始记账 👇</p>;
  }

  const yesterday = addDays(today(), -1);

  return (
    <form onSubmit={submit} className="space-y-5 pb-1">
      <div className="flex items-baseline gap-2 rounded-2xl bg-zinc-100/80 px-4 py-3 ring-brand-500/60 transition focus-within:bg-white focus-within:ring-2 dark:bg-white/6 dark:focus-within:bg-white/8">
        <span className="text-2xl font-semibold text-zinc-400">¥</span>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          aria-label="金额"
          autoFocus={!expense && window.matchMedia('(min-width: 1024px)').matches}
          className="tabular min-w-0 flex-1 bg-transparent text-[32px] leading-tight font-semibold tracking-tight outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
        />
      </div>

      <div>
        <Label aside={<span className="tabular text-xs text-zinc-400">{title.length}/{LIMITS.title}</span>}>用途</Label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={LIMITS.title}
          placeholder="例如：午饭"
          className="field"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setTitle(s)}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs transition',
                title === s
                  ? 'bg-brand-500 text-white'
                  : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-white/6 dark:text-zinc-300 dark:hover:bg-white/10',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div>
        <Label>日期</Label>
        <div className="flex gap-2">
          {[
            [today(), '今天'],
            [yesterday, '昨天'],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setDate(value!)}
              className={cn(
                'h-11 rounded-2xl px-4 text-sm font-medium transition',
                date === value
                  ? 'bg-brand-500/12 text-brand-600 ring-1 ring-brand-500/40 dark:text-brand-300'
                  : 'bg-zinc-100/80 text-zinc-600 hover:bg-zinc-200/70 dark:bg-white/6 dark:text-zinc-300',
              )}
            >
              {label}
            </button>
          ))}
          <input
            type="date"
            value={date}
            max="9999-12-31"
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="field tabular min-w-0 flex-1 px-3 text-center"
            aria-label="选择日期"
          />
        </div>
      </div>

      <div>
        <Label>谁付的钱</Label>
        <div className="flex flex-wrap gap-2">
          {members.map((m) => (
            <MemberChip key={m.id} active={payerId === m.id} onClick={() => setPayerId(m.id)} member={m} />
          ))}
        </div>
      </div>

      <div>
        <Label
          aside={
            <button
              type="button"
              onClick={() => setSelected(new Set(allSelected ? [] : members.map((m) => m.id)))}
              className="rounded-full px-2 py-0.5 text-xs text-brand-600 hover:bg-brand-500/10 dark:text-brand-300"
            >
              {allSelected ? '全不选' : '全选'}
            </button>
          }
        >
          谁一起分摊 · {participantIds.length}/{members.length}
        </Label>
        <div className="flex flex-wrap gap-2">
          {members.map((m) => (
            <MemberChip key={m.id} active={selected.has(m.id)} onClick={() => toggle(m.id)} member={m} multi />
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between rounded-2xl bg-brand-500/6 px-4 py-3 text-sm dark:bg-brand-400/8">
        <span className="text-zinc-500 dark:text-zinc-400">
          {participantIds.length > 0 ? `${participantIds.length} 人平摊，每人` : '请选择参与者'}
        </span>
        <span className="tabular font-semibold text-brand-600 dark:text-brand-300">
          {shares.length ? formatMoney(shares[shares.length - 1]!.amount) : '—'}
          {shares.length > 1 && shares[0]!.amount !== shares[shares.length - 1]!.amount && (
            <span className="ml-1 text-xs font-normal text-zinc-400">起</span>
          )}
        </span>
      </div>

      <div className="flex gap-2">
        {expense && (
          <Button variant="danger" size="lg" onClick={remove} loading={deleting} icon={<Trash2 className="size-4" />}>
            删除
          </Button>
        )}
        <Button type="submit" variant="primary" size="lg" className="flex-1" loading={saving} icon={<Check className="size-4" />}>
          {expense ? '保存修改' : '记一笔'}
        </Button>
      </div>
    </form>
  );
}

export function MemberChip({
  member,
  active,
  onClick,
  multi,
}: {
  member: { id: string; name: string; avatar: string };
  active: boolean;
  onClick: () => void;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex h-10 items-center gap-1.5 rounded-full py-1 pr-3.5 pl-1 text-sm font-medium transition active:scale-95',
        active
          ? 'bg-brand-500 text-white shadow-[0_4px_12px_-4px] shadow-brand-500/60'
          : 'bg-zinc-100/80 text-zinc-700 hover:bg-zinc-200/70 dark:bg-white/6 dark:text-zinc-200 dark:hover:bg-white/10',
        multi && !active && 'opacity-70',
      )}
    >
      <Avatar member={member} size="sm" className={active ? 'bg-white/90 text-zinc-800 dark:bg-white/90 dark:text-zinc-800' : undefined} />
      {member.name}
    </button>
  );
}
