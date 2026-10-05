import { Check, ScanLine, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState, useSyncExternalStore, type ChangeEvent, type FormEvent } from 'react';
import { toast } from 'sonner';
import { centsToInput, formatMoney, parseAmount, splitEvenly } from '../../../shared/money.ts';
import { LIMITS } from '../../../shared/limits.ts';
import type { ExpenseInput } from '../../../shared/schema.ts';
import type { BillDraft, Expense } from '../../../shared/types.ts';
import { Avatar } from '../../components/Avatar.tsx';
import { AutoHeight } from '../../components/AutoHeight.tsx';
import { Button } from '../../components/Button.tsx';
import { Label } from '../../components/Card.tsx';
import { Collapse } from '../../components/Collapse.tsx';
import { common } from '../../i18n/common.ts';
import { expense as t } from '../../i18n/expense.ts';
import { api, call, errorMessage } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { addDays, today } from '../../lib/dates.ts';
import { compressImage } from '../../lib/image.ts';
import { BillBatch, type BillRow } from './BillBatch.tsx';
import { load, save } from '../../lib/storage.ts';
import { useLedger } from './context.tsx';

const MAX_IMAGES = 6;

const payerListeners = new Set<() => void>();

export function saveDefaultPayer(storageKey: string, id: string) {
  save(storageKey, id);
  for (const l of payerListeners) l();
}

export function useDefaultPayer(storageKey: string) {
  return useSyncExternalStore(
    (cb) => {
      payerListeners.add(cb);
      return () => void payerListeners.delete(cb);
    },
    () => load<string | null>(storageKey, null),
  );
}

export function ExpenseForm({ expense, onDone }: { expense?: Expense; onDone?: () => void }) {
  const { snapshot, store, key, memberById, recognize } = useLedger();
  const { members } = snapshot;

  const [amount, setAmount] = useState(expense ? centsToInput(expense.amount) : '');
  const [title, setTitle] = useState(expense?.title ?? '');
  const [date, setDate] = useState(expense?.date ?? today());
  const defaultPayer = useDefaultPayer(key('payer'));
  const [editedPayer, setEditedPayer] = useState(expense?.payerId ?? '');
  const payerId = expense ? editedPayer : defaultPayer && memberById.has(defaultPayer) ? defaultPayer : '';
  const choosePayer = (id: string) => (expense ? setEditedPayer(id) : saveDefaultPayer(key('payer'), id));
  const [picked, setPicked] = useState(() => (expense ? new Set(expense.shares.map((s) => s.memberId)) : null));
  // 新记一笔时只记住没选的人，之后加入的成员（包括表单打开期间）默认参与
  const [excluded, setExcluded] = useState(() => new Set(load<string[]>(key('excluded-participants'), [])));
  const selected = picked ?? new Set(members.filter((m) => !excluded.has(m.id)).map((m) => m.id));
  const choose = (next: Set<string>) => {
    if (picked) return setPicked(next);
    const out = members.filter((m) => !next.has(m.id)).map((m) => m.id);
    setExcluded(new Set(out));
    save(key('excluded-participants'), out);
  };
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [drafts, setDrafts] = useState<BillRow[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickImages = () => fileInput.current?.click();

  const cents = parseAmount(amount);
  const participantIds = members.filter((m) => selected.has(m.id)).map((m) => m.id);
  const shares = cents ? splitEvenly(cents, participantIds) : [];
  const allSelected = members.length > 0 && participantIds.length === members.length;

  const liveSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of snapshot.expenses.slice(0, 200)) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
    const recent = [...counts].sort((a, b) => b[1] - a[1]).map(([title]) => title);
    return [...new Set([...recent, ...t.form.suggestions])].slice(0, 6);
  }, [snapshot.expenses]);
  // 弹窗里提交后表单随弹窗关掉，而账目更新常先于弹窗退场到达，建议跟着重排会在关闭时闪一下
  const [openedSuggestions] = useState(liveSuggestions);
  const suggestions = onDone ? openedSuggestions : liveSuggestions;

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    choose(next);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (drafts) return submitBatch(drafts);
    if (!cents) return toast.error(t.form.invalidAmount);
    if (!title.trim()) return toast.error(t.form.titleRequired);
    if (!payerId) return toast.error(t.form.payerRequired);
    if (participantIds.length === 0) return toast.error(t.form.participantsRequired);

    const input = { title: title.trim(), amount: cents, payerId, date, participantIds };
    setSaving(true);
    try {
      if (expense) {
        if (unchanged(expense, input)) return onDone?.();
        await store.mutate(api.ledger.expenses[':id'].$patch({ param: { id: expense.id }, json: input }));
        toast.success(t.form.saved);
      } else {
        await store.mutate(api.ledger.expenses.$post({ json: input }));
        toast.success(t.form.added(input.title, formatMoney(cents)));
        // 在弹窗里时表单随弹窗关掉，这时清空会让退场动画里的内容先变一下
        if (!onDone) {
          setAmount('');
          setTitle('');
        }
      }
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function submitBatch(rows: BillRow[]) {
    const inputs: { key: string; input: ExpenseInput }[] = [];
    for (const [index, row] of rows.entries()) {
      if (!row.checked) continue;
      const rowCents = parseAmount(row.amount);
      if (!row.title.trim()) return toast.error(t.form.rowTitleRequired(index + 1));
      if (!rowCents) return toast.error(t.form.rowAmountInvalid(index + 1));
      inputs.push({ key: row.key, input: { title: row.title.trim(), amount: rowCents, payerId, date: row.date, participantIds } });
    }
    if (inputs.length === 0) return toast.error(t.form.noneChecked);
    if (!payerId) return toast.error(t.form.payerRequired);
    if (participantIds.length === 0) return toast.error(t.form.participantsRequired);

    setSaving(true);
    const saved = new Set<string>();
    try {
      for (const { key: rowKey, input } of inputs) {
        await store.mutate(api.ledger.expenses.$post({ json: input }));
        saved.add(rowKey);
      }
      toast.success(t.form.addedBatch(inputs.length, formatMoney(inputs.reduce((sum, { input }) => sum + input.amount, 0))));
      setDrafts(null);
      onDone?.();
    } catch (err) {
      setDrafts(rows.filter((r) => !saved.has(r.key)));
      toast.error(saved.size ? t.form.partiallyAdded(saved.size, errorMessage(err)) : errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function scan(e: ChangeEvent<HTMLInputElement>) {
    const all = [...(e.target.files ?? [])];
    e.target.value = '';
    if (all.length === 0) return;
    if (all.length > MAX_IMAGES) toast(t.form.tooManyImages(MAX_IMAGES));
    setScanning(true);
    const results = await Promise.allSettled(
      all.slice(0, MAX_IMAGES).map(async (file) => {
        const image = await compressImage(file).catch(() => {
          throw new Error(t.form.unreadableImage);
        });
        return (await call(api.ledger.recognize.$post({ json: { image } }))).items;
      }),
    );
    setScanning(false);

    const found = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failures = results.flatMap((r) => (r.status === 'rejected' ? [errorMessage(r.reason)] : []));
    if (found.length === 0) return toast.error(failures[0] ?? t.form.nothingFound);
    const skipped = failures.length ? t.form.imagesSkipped(failures.length) : '';

    if (found.length === 1 && !drafts) {
      const [draft] = found as [BillDraft];
      if (draft.amount) setAmount(centsToInput(draft.amount));
      if (draft.title) setTitle(draft.title);
      if (draft.date) setDate(draft.date);
      const missing = [!draft.amount && t.form.missingAmount, !draft.title && t.form.missingTitle].filter((f) => f !== false);
      toast.success((missing.length ? t.form.recognizedMissing(missing) : t.form.recognized) + skipped);
      return;
    }

    const rows = [...(drafts ?? [])];
    for (const draft of found) {
      const rowDate = draft.date ?? today();
      const duplicate =
        draft.amount !== null &&
        (snapshot.expenses.some((x) => x.amount === draft.amount && x.date === rowDate) ||
          rows.some((r) => parseAmount(r.amount) === draft.amount && r.date === rowDate));
      rows.push({
        key: crypto.randomUUID(),
        title: draft.title ?? '',
        amount: draft.amount ? centsToInput(draft.amount) : '',
        date: rowDate,
        checked: !duplicate,
        duplicate,
      });
    }
    setDrafts(rows);
    toast.success(t.form.recognizedBatch(found.length) + skipped);
  }

  async function remove() {
    if (!expense) return;
    setDeleting(true);
    try {
      await store.mutate(api.ledger.expenses[':id'].$delete({ param: { id: expense.id } }));
      toast.success(t.form.deleted(expense.title));
      onDone?.();
    } catch (err) {
      toast.error(errorMessage(err));
      setDeleting(false);
    }
  }

  const yesterday = addDays(today(), -1);
  const batch = drafts
    ? drafts.reduce(
        (acc, r) => (r.checked ? { count: acc.count + 1, total: acc.total + (parseAmount(r.amount) ?? 0) } : acc),
        { count: 0, total: 0 },
      )
    : { count: 0, total: 0 };

  return (
    <>
      <Collapse open={members.length === 0}>
        <p className="py-6 text-center text-sm text-zinc-500">{t.form.noMembers}</p>
      </Collapse>
      <Collapse open={members.length > 0}>
        <form onSubmit={submit} className="space-y-5 pb-1">
          {recognize && !expense && <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={scan} />}
          <div>
            <AutoHeight className="-m-1 p-1">
              {drafts ? (
                <BillBatch rows={drafts} onChange={setDrafts} onAddImages={pickImages} onCancel={() => setDrafts(null)} scanning={scanning} />
              ) : (
                <div className="space-y-5">
                  <div className="flex items-baseline gap-2 rounded-2xl bg-zinc-100/80 px-4 py-3 ring-brand-500/60 transition focus-within:bg-white focus-within:ring-2 dark:bg-white/6 dark:focus-within:bg-white/8">
                    <span className="text-2xl font-semibold text-zinc-400">¥</span>
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={t.amount}
                      autoFocus={!expense && window.matchMedia('(min-width: 1024px)').matches}
                      className="tabular min-w-0 flex-1 bg-transparent text-[32px] leading-tight font-semibold tracking-tight outline-none placeholder:text-zinc-300 dark:placeholder:text-zinc-600"
                    />
                    {recognize && !expense && (
                      <>
                        <Button
                          variant="soft"
                          size="sm"
                          className="self-center"
                          loading={scanning}
                          icon={<ScanLine className="size-4" />}
                          onClick={pickImages}
                        >
                          {t.form.scan}
                        </Button>
                      </>
                    )}
                  </div>

                  <div>
                    <Label aside={<span className="tabular text-xs text-zinc-400">{title.length}/{LIMITS.title}</span>}>{t.title}</Label>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      maxLength={LIMITS.title}
                      placeholder={t.form.titlePlaceholder}
                      className="field"
                    />
                    <AutoHeight className="-m-1 p-1">
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
                    </AutoHeight>
                  </div>

                  <div>
                    <Label>{t.date}</Label>
                    <div className="flex gap-2">
                      {[
                        [today(), common.today],
                        [yesterday, common.yesterday],
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
                        aria-label={t.form.pickDate}
                      />
                    </div>
                  </div>
                </div>
              )}
            </AutoHeight>
          </div>

          <div>
            <Label>{t.paidBy}</Label>
            <AutoHeight className="-m-1 p-1">
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <MemberChip key={m.id} active={payerId === m.id} onClick={() => choosePayer(m.id)} member={m} />
                ))}
              </div>
            </AutoHeight>
          </div>

          <div>
            <Label
              aside={
                <button
                  type="button"
                  onClick={() => choose(new Set(allSelected ? [] : members.map((m) => m.id)))}
                  className="rounded-full px-2 py-0.5 text-xs text-brand-600 hover:bg-brand-500/10 dark:text-brand-300"
                >
                  {allSelected ? t.form.selectNone : t.form.selectAll}
                </button>
              }
            >
              {t.form.splitBetween} · {participantIds.length}/{members.length}
            </Label>
            <AutoHeight className="-m-1 p-1">
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <MemberChip key={m.id} active={selected.has(m.id)} onClick={() => toggle(m.id)} member={m} multi />
                ))}
              </div>
            </AutoHeight>
          </div>

          <div className="flex items-center justify-between rounded-2xl bg-brand-500/6 px-4 py-3 text-sm dark:bg-brand-400/8">
            {drafts ? (
              <>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {t.form.batchTotal(batch.count, participantIds.length)}
                </span>
                <span className="tabular font-semibold text-brand-600 dark:text-brand-300">{formatMoney(batch.total)}</span>
              </>
            ) : (
              <>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {participantIds.length > 0 ? t.form.perPerson(participantIds.length) : t.form.choosePeople}
                </span>
                <span className="tabular font-semibold text-brand-600 dark:text-brand-300">
                  {shares.length ? formatMoney(shares[shares.length - 1]!.amount) : '—'}
                  {shares.length > 1 && shares[0]!.amount !== shares[shares.length - 1]!.amount && (
                    <span className="ml-1 text-xs font-normal text-zinc-400">{t.form.unevenShares}</span>
                  )}
                </span>
              </>
            )}
          </div>

          <div className="flex gap-2">
            {expense && (
              <Button variant="danger" size="lg" onClick={remove} loading={deleting} icon={<Trash2 className="size-4" />}>
                {t.form.delete}
              </Button>
            )}
            <Button type="submit" variant="primary" size="lg" className="flex-1" loading={saving} icon={<Check className="size-4" />}>
              {expense ? t.form.saveChanges : drafts ? t.form.addBatch(batch.count) : t.form.add}
            </Button>
          </div>
        </form>
      </Collapse>
    </>
  );
}

function unchanged(expense: Expense, input: ExpenseInput) {
  const before = expense.shares.map((s) => s.memberId).sort().join();
  return (
    expense.title === input.title &&
    expense.amount === input.amount &&
    expense.payerId === input.payerId &&
    expense.date === input.date &&
    before === [...input.participantIds].sort().join()
  );
}

export function MemberChip({
  member,
  active,
  onClick,
  multi,
  disabled,
}: {
  member: { id: string; name: string; avatar: string };
  active: boolean;
  onClick: () => void;
  multi?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        'flex h-10 items-center gap-1.5 rounded-full py-1 pr-3.5 pl-1 text-sm font-medium transition active:scale-95 disabled:opacity-30 disabled:active:scale-100',
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
